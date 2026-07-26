#!/usr/bin/env node
// wplive — measure the RUNNING app, not a fixture.
//
// wp5a turned 150 visual gates green against the e2e harness while the real
// app showed a sidebar where nothing was clickable. The harness injects online
// instances and opens a page rather than a window, so the state the user was
// actually in never occurred. This runs against whatever is really there.
//
// The origin is NOT discovered here. It is passed in, because a Chrome tab and
// an Electron window can be attached to different managers and comparing them
// produces disagreements that mean nothing. See verify-live-window-evidence.mjs.
//
// Usage:
//   node scripts/qa/live-app-qa.mjs --origin http://127.0.0.1:24577 \
//        [--evidence evidence/wplive.window.json] [--out evidence/wplive.dom.json]
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { cleanupDecision, lockVerdict, recoveryDecision, stopConfirmed } from './live-ownership.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const origin = flag('origin');
const evidencePath = flag('evidence');
const outPath = flag('out');
const cdp = flag('cdp', 'http://127.0.0.1:9222');

if (!origin) {
    console.error('[wplive] --origin is required. Get it from the Computer Use evidence:');
    console.error('  node scripts/qa/verify-live-window-evidence.mjs evidence/wplive.window.json');
    process.exit(2);
}

const report = { when: new Date().toISOString(), origin, checks: {}, identity: {} };
/** Everything this run can prove about the instance it started. */
function ownership() {
    if (!startedPort) return null;
    return { port: startedPort, managerPid: health?.pid ?? null, instancePid: startedInstancePid };
}

/** What the manager says about one port, right now. Never throws. */
async function observePort(port) {
    try {
        const body = await getJson('/api/dashboard/instances');
        if (!Array.isArray(body?.instances)) return { queryFailed: true };
        const health = await getJson('/api/dashboard/health');
        return {
            managerPid: health?.pid ?? null,
            instance: body.instances.find((x) => x.port === port) ?? null,
        };
    } catch {
        return { queryFailed: true };
    }
}

// Ownership journal: written before any lifecycle mutation, removed only once
// the stop is confirmed. A run that dies outright leaves it behind for the next.
//
// A port alone is not ownership. A journal saying "3457" cannot tell an
// instance THIS tool started from one the user started later on the same port,
// or from a manager that has since restarted — and acting on that ambiguity
// means stopping someone's work. So it records who, which manager, and how far
// the start actually got.
const JOURNAL = `${tmpdir()}/wplive-started-instance.json`;
const LOCK = `${tmpdir()}/wplive-runner.lock`;
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
let startedPort = null;
let startedInstancePid = null;
const failures = [];

/** A stable fingerprint of the instance list, order-independent. */
function snapshotHash(instances) {
    const canonical = [...instances]
        .map((i) => `${i.port}:${i.status}`)
        .sort()
        .join('|');
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

async function getJson(path) {
    const res = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
}

// ── 0. alignment ────────────────────────────────────────────────────────────
//
// Re-measure what the evidence claims rather than trusting it. A field only one
// side ever looks at is not cross-checked, and this file says so where that is
// the case.
let evidence = null;
if (evidencePath) {
    try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
    catch (error) { console.error(`[wplive] cannot read evidence: ${error.message}`); process.exit(2); }
}

const health = await getJson('/api/dashboard/health').catch((e) => {
    console.error(`[wplive] manager did not answer at ${origin}: ${e.message}`);
    process.exit(1);
});
report.identity.runner = { managerPid: health.pid, managerPort: health.port, origin };

if (evidence) {
    report.identity.evidence = {
        rendererOrigin: evidence.rendererOrigin,
        windowPid: evidence.windowPid,          // OS-only; nothing to compare against
        managerPid: evidence.managerPid,
        managerPort: evidence.managerPort,
    };

    // Target mismatch is fatal: we are looking at a different application.
    const mismatches = [];
    if (evidence.rendererOrigin !== origin) mismatches.push(`origin ${evidence.rendererOrigin} != ${origin}`);
    if (evidence.managerPid !== health.pid) mismatches.push(`manager pid ${evidence.managerPid} != ${health.pid}`);
    if (evidence.managerPort !== health.port) mismatches.push(`manager port ${evidence.managerPort} != ${health.port}`);
    if (mismatches.length) {
        report.identity.verdict = 'target-mismatch';
        console.error(`[wplive] TARGET MISMATCH — the two verifiers are not on the same app:`);
        for (const m of mismatches) console.error(`  ${m}`);
        await save();
        process.exit(1);
    }

    // State drift is NOT a mismatch. Instances go up and down between two
    // requests, and this runner starts one itself later on. Converge instead of
    // failing, and if it will not settle say `unstable` rather than blaming the
    // target.
    let hash = snapshotHash((await getJson('/api/dashboard/instances')).instances ?? []);
    const matchesEvidence = hash === evidence.instanceSnapshotHash;
    let settled = matchesEvidence;
    for (let attempt = 0; !settled && attempt < 3; attempt += 1) {
        await new Promise((r) => setTimeout(r, 1200));
        const next = snapshotHash((await getJson('/api/dashboard/instances')).instances ?? []);
        settled = next === hash;   // stable across two reads is good enough
        hash = next;
    }
    report.identity.snapshot = { evidence: evidence.instanceSnapshotHash, runner: hash, matchesEvidence, settled };

    // Do not call drift `aligned`. The target is the same app either way —
    // that is what the pid/port/origin check above established — but the state
    // has moved, and recording it as full alignment would let a stale evidence
    // file look like a fresh cross-check. The hash cannot be re-collected on
    // the OS side from here, so per the plan it stops being an identity field
    // and becomes point-in-time state evidence.
    report.identity.verdict = !settled ? 'unstable'
        : matchesEvidence ? 'aligned'
        : 'aligned-target/state-drift';
    if (!settled) {
        console.error('[wplive] UNSTABLE — the instance list would not settle. Not a target mismatch.');
        await save();
        process.exit(1);
    }
} else {
    report.identity.verdict = 'unverified';
    console.error('[wplive] no --evidence given: running without a cross-checked identity.');
}

// Refuse to run two of these at once. Two runners sharing one journal would
// overwrite each other's ownership record, and then neither can prove what it
// started.
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
    await writeFile(LOCK, RUN_ID, { flag: 'wx' });
} catch {
    // A lock left by a crashed run must not block every future run, but one
    // held by a live run must. Ask the holder's pid rather than a human.
    let contents = '';
    try { contents = await readFile(LOCK, 'utf8'); } catch { /* raced */ }
    const verdict = lockVerdict(contents, alivePid);
    if (verdict.verdict === 'held') {
        console.error(`[wplive] another run holds ${LOCK}: ${verdict.reason}`);
        process.exit(1);
    }
    console.error(`[wplive] reclaiming a stale lock (${verdict.reason})`);
    await writeFile(LOCK, RUN_ID);
}
// `require` does not exist in an ES module — the old handler threw on every
// exit and swallowed it, so the lock was never released and the next run was
// refused. Import the sync unlink properly.
process.on('exit', () => { try { unlinkSync(LOCK); } catch { /* already gone */ } });

// Adopt anything a previous run started and could not stop. This has to happen
// after alignment (so we know we are talking to the right manager) and before
// any mutation of our own — and if it does not come back clean, stop here
// rather than starting yet another instance on top of an unresolved one.
const recovery = await recoverOrphans();
if (recovery !== 'clean') {
    console.error('\n[wplive] refusing to start anything while a previous run\'s instance is unresolved.');
    report.identity.recovery = recovery;
    await save();
    process.exit(1);
}

// ── the page ────────────────────────────────────────────────────────────────
const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
let page = context.pages().find((p) => p.url().startsWith(`${origin}/dashboard2`));
if (!page) {
    page = await context.newPage();
    await page.goto(`${origin}/dashboard2/`, { waitUntil: 'domcontentloaded' });
}
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.d2-shell', { timeout: 20_000 });
await page.waitForTimeout(2000);

function record(name, ok, detail) {
    report.checks[name] = { ok, ...detail };
    if (!ok) failures.push(name);
    console.error(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
}

try {
    // ── 1. offline rows are status, not dead controls ───────────────────────
    //
    // The reported symptom. Fifty rows rendered as `<button disabled>` look
    // like controls, sit in the tab order, and refuse every click.
    const rows = await page.evaluate(() => ({
        total: document.querySelectorAll('.d2-instance-row').length,
        deadButtons: [...document.querySelectorAll('button.d2-instance-main')].filter((b) => b.disabled).length,
        statusElements: document.querySelectorAll('.d2-instance-main.is-offline').length,
        offlineInTabOrder: [...document.querySelectorAll('.d2-instance-main.is-offline')]
            .filter((e) => e.tabIndex >= 0).length,
        startCtas: [...document.querySelectorAll('.d2-instance-control.is-start')]
            .map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled })),
    }));
    // Enabled, not merely labelled. A row of Start buttons that are all disabled
    // is the same dead end wearing a different hat, and checking the label alone
    // would have passed it.
    const ctasUsable = rows.startCtas.length > 0
        && rows.startCtas.every((c) => c.label?.startsWith('Start') && c.disabled === false);
    record('offline-rows-are-not-dead-buttons',
        rows.deadButtons === 0 && rows.offlineInTabOrder === 0 && ctasUsable
            // One usable start control per offline row, so a row cannot lose
            // its only way forward and still pass.
            && rows.startCtas.length >= rows.statusElements,
        { deadButtons: rows.deadButtons, statusElements: rows.statusElements,
          offlineInTabOrder: rows.offlineInTabOrder, startCtas: rows.startCtas.length,
          disabledCtas: rows.startCtas.filter((c) => c.disabled).length });

    // ── 2. resize affordances ───────────────────────────────────────────────
    //
    // Two different surfaces. The workbench divider only exists when the side
    // pane is open, so it must be opened first — measuring a closed pane and
    // reporting "MISSING" is what sent me chasing an Electron bug that was not
    // there.
    const sidebarHandle = await page.evaluate(() => {
        const el = document.querySelector('.d2-sidebar-resize');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return {
            cursor: getComputedStyle(el).cursor,
            hitsItself: document.elementFromPoint(cx, cy) === el,
            grabWidth: [-3, -2, -1, 0, 1, 2, 3]
                .filter((dx) => document.elementFromPoint(cx + dx, cy) === el).length,
        };
    });
    record('sidebar-resize-handle',
        Boolean(sidebarHandle?.cursor === 'col-resize' && sidebarHandle.hitsItself),
        sidebarHandle ?? { missing: true });

    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
            .find((b) => /Open side pane/i.test(b.getAttribute('aria-label') ?? ''));
        btn?.click();
    });
    await page.waitForTimeout(900);
    const divider = await page.evaluate(() => {
        const el = document.querySelector('.d2-workbench-divider-drag');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return {
            cursor: getComputedStyle(el).cursor,
            role: el.getAttribute('role'),
            grabWidth: [-3, -2, -1, 0, 1, 2, 3]
                .filter((dx) => document.elementFromPoint(cx + dx, cy) === el).length,
        };
    });
    record('workbench-divider-present-when-pane-open',
        Boolean(divider?.cursor === 'col-resize' && divider.role === 'separator'),
        divider ?? { missing: true, note: 'the divider only renders with the side pane open' });

    // Existing is not working. A divider that is present, correctly shaped, and
    // does nothing when dragged is exactly the symptom being chased — so drive
    // it both ways a user would and require the pane width to move.
    if (divider) {
        const paneWidth = () => page.evaluate(() =>
            Math.round(document.querySelector('.d2-side-pane')?.getBoundingClientRect().width ?? 0));
        const startWidth = await paneWidth();

        const dbox = await page.locator('.d2-workbench-divider-drag').boundingBox();
        await page.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
        await page.mouse.down();
        await page.mouse.move(dbox.x - 90, dbox.y + dbox.height / 2, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        const afterDrag = await paneWidth();

        // Both directions, separately. Pressing one arrow twice cannot tell a
        // working control from one that only moves one way.
        await page.locator('.d2-workbench-divider-drag').focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(500);
        const afterRight = await paneWidth();
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(500);
        const afterLeft = await paneWidth();

        record('workbench-divider-actually-resizes',
            afterDrag !== startWidth && afterRight !== afterDrag && afterLeft !== afterRight,
            { startWidth, afterDrag, afterRight, afterLeft });
    }

    // ── 3. the sidebar scrolls AFTER selecting a session ────────────────────
    //
    // The report was "can't scroll after selecting an instance". Measuring the
    // initial offline list instead would pass while never reaching the state
    // being described, so this drives the app into that state first.
    //
    // Observed as a gesture, not as accessibility-tree order: the sidebar is
    // not virtualized, so a full AX tree keeps offscreen children in document
    // order and the first child staying put proves nothing.
    await scrollAfterSelection();

    // ── 4. (removed after review) ───────────────────────────────────────────
    //
    // A generic "no list where every control is disabled" check lived here. It
    // is gone rather than tuned. The honest version needs a per-surface manifest
    // of which controls form a peer group; without one it is trivially
    // defeated — fifty disabled rows plus one enabled utility button in the
    // same container passes. The dedicated `offline-rows-are-not-dead-buttons`
    // check above catches the real regression more precisely, and a gate that
    // looks thorough while proving little is worse than no gate at all.
} finally {
    await browser.close();
}

/**
 * Reach the post-selection state, then send a real wheel gesture.
 *
 * Starting an instance is a side effect, so it is tracked and undone. Sessions
 * are never created: `chat-sessions` has no DELETE, so anything created here
 * could not be cleaned up. If no session exists the check reports
 * `unavailable` rather than falling back to the offline list, which would be
 * measuring a different state and calling it a pass.
 */
async function scrollAfterSelection() {
    const instances = (await getJson('/api/dashboard/instances')).instances ?? [];
    let target = instances.find((i) => i.status === 'online');
    // What this run owns, filled in as the start progresses. A port alone is never
// enough to justify a stop: `instancePid` is what proves the process on that
// port is the one we created.
let startedByUs = null;

    if (!target) {
        const candidate = instances.find((i) => i.lifecycle?.canStart);
        if (!candidate) {
            record('sidebar-scrolls-after-selection', false,
                { unavailable: 'no online instance and none can be started' });
            return;
        }
        // Record ownership BEFORE the mutation, and arm the signal handlers, so
        // a crash or a Ctrl-C between here and the finally does not leave a
        // process running on the developer's machine. A journal on disk lets
        // the next run clean up even if this one is killed outright.
        startedByUs = candidate.port;
        startedPort = candidate.port;
        // Phase 1: intent. If the run dies here nothing was started, and
        // recovery must NOT stop anything on the strength of an intent alone.
        await writeFile(JOURNAL, JSON.stringify({
            runId: RUN_ID, origin, port: candidate.port,
            managerPid: health.pid, phase: 'intent', at: new Date().toISOString(),
        }, null, 2));
        armSignalCleanup();
        // Start through the CTA the user would press, not the manager API.
        // Calling the API directly would stay green even if the button's click
        // handler were severed — which is the whole surface under test here.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.d2-shell', { timeout: 20_000 });
        await page.waitForTimeout(1500);
        // Bind the CTA to the port, not to a label. Instance labels repeat —
        // several are literally "jwc" — so a label match can click a different
        // row than the one we journalled, and then cleanup stops the wrong
        // instance. The port is printed in the row, so scope to that node.
        const ctaRequests = [];
        const onRequest = (req) => {
            if (!req.url().includes('/api/dashboard/lifecycle/')) return;
            let body = null;
            try { body = JSON.parse(req.postData() ?? 'null'); } catch { /* not json */ }
            ctaRequests.push({ url: req.url(), port: body?.port ?? null });
        };
        page.on('request', onRequest);
        const node = page.locator('.d2-instance-node')
            .filter({ hasText: `:${candidate.port}` }).first();
        if (!(await node.count())) {
            page.off('request', onRequest);
            record('sidebar-scrolls-after-selection', false,
                { unavailable: `no row for :${candidate.port} in the sidebar` });
            return;
        }
        await node.locator('.d2-instance-control.is-start').first().click({ timeout: 10_000 });
        await page.waitForTimeout(2500);
        page.off('request', onRequest);
        // Exactly one request, and for the port we are about to be responsible
        // for stopping.
        record('start-cta-issues-exactly-one-request',
            ctaRequests.length === 1 && ctaRequests[0]?.port === candidate.port,
            { requests: ctaRequests.length, expectedPort: candidate.port,
              sawPort: ctaRequests[0]?.port ?? null, url: ctaRequests[0]?.url ?? null });

        for (let i = 0; i < 20 && !target; i += 1) {
            await new Promise((r) => setTimeout(r, 1500));
            const fresh = (await getJson('/api/dashboard/instances')).instances ?? [];
            target = fresh.find((x) => x.port === candidate.port && x.status === 'online');
        }
        if (target) {
            // Phase 2: ownership. The pid is what makes a later recovery safe —
            // if the process behind that port is a different one, it is not
            // ours and must be left alone.
            startedInstancePid = target.lifecycle?.pid ?? null;
            await writeFile(JOURNAL, JSON.stringify({
                runId: RUN_ID, origin, port: candidate.port,
                managerPid: health.pid, instancePid: startedInstancePid,
                phase: 'online', at: new Date().toISOString(),
            }, null, 2));
        }
        if (!target) {
            record('sidebar-scrolls-after-selection', false,
                { unavailable: `instance ${candidate.port} never came online` });
            await stopIfOurs(ownership());
            return;
        }
    }

    // Everything past the mutation runs inside try/finally, including the
    // polling above's own failure path, so nothing we started outlives the run.
    try {
        const sessions = await getJson(`/i/${target.port}/api/chat-sessions`)
            .then((r) => r.data?.sessions ?? [])
            .catch(() => []);
        if (!sessions.length) {
            record('sidebar-scrolls-after-selection', false,
                { unavailable: `instance ${target.port} has no session; not creating one (no DELETE route)` });
            return;
        }

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.d2-shell', { timeout: 20_000 });
        await page.waitForTimeout(2500);

        // One session auto-selects and the session list is not rendered at all;
        // more than one requires expanding and clicking a row.
        const row = page.locator('button.d2-instance-main').filter({ hasText: String(target.port) }).first();
        await row.click({ timeout: 10_000 });
        await page.waitForTimeout(1500);
        // With more than one session the list renders and a row must be picked.
        // Remember WHICH one, so the scope check has something to compare
        // against — otherwise any session on the right port would pass.
        let clickedSession = sessions.length === 1 ? sessions[0].id : null;
        if (sessions.length > 1) {
            const rows = page.locator('.d2-session-row');
            await rows.first().waitFor({ timeout: 10_000 });
            const label = (await rows.first().textContent() ?? '').trim();
            clickedSession = sessions.find((x) => label.includes(x.id))?.id
                ?? sessions.find((x) => x.label && label.includes(x.label))?.id
                ?? null;
            await rows.first().click({ timeout: 10_000 });
            await page.waitForTimeout(1200);
        }

        // Prove the state rather than trusting the click.
        // A ChatView existing proves nothing: another instance may already have
        // been selected, in which case the single-session auto-select never
        // runs (`if (selected) return`) and this would pass while measuring the
        // wrong scope. Require the workbench to be showing OUR instance.
        // The workbench title shows an instance LABEL, and labels repeat, so it
        // cannot identify a scope. Read the port and session id the chat view
        // is actually bound to.
        const selection = await page.evaluate(() => {
            const view = document.querySelector('[data-testid="chat-view"]');
            return {
                chatView: Boolean(view),
                port: view?.getAttribute('data-port') ?? null,
                sessionId: view?.getAttribute('data-session-id') ?? null,
                selectedRows: document.querySelectorAll('.d2-session-row.is-selected').length,
                title: document.querySelector('.d2-workbench-title')?.textContent?.trim() ?? null,
            };
        });
        // The session id is always compared. When the row's text did not
        // identify a session we cannot claim to know which one we opened, so
        // that is a failure rather than a free pass.
        const expectedSession = clickedSession;
        const showsOurTarget = selection.port === String(target.port)
            && Boolean(expectedSession) && selection.sessionId === expectedSession;
        const inSelectedState = selection.chatView && showsOurTarget;
        selection.expectedPort = target.port;
        selection.expectedSession = expectedSession;
        selection.showsOurTarget = showsOurTarget;
        if (!inSelectedState) {
            record('sidebar-scrolls-after-selection', false,
                { reachedSelection: false, ...selection });
            return;
        }

        const before = await page.evaluate(() => {
            const el = document.querySelector('.d2-sidebar-list');
            return el ? { top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight } : null;
        });
        if (!before || before.h <= before.c) {
            record('sidebar-scrolls-after-selection', true, { skipped: 'nothing to scroll', ...before, ...selection });
            return;
        }
        const box = await page.locator('.d2-sidebar-list').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => document.querySelector('.d2-sidebar-list').scrollTop);
        record('sidebar-scrolls-after-selection', after !== before.top,
            { before: before.top, after, delta: after - before.top, ...selection });
    } finally {
        await stopIfOurs(ownership());
    }
}

/**
 * Undo only what this run started. A pre-existing instance is left running.
 *
 * Swallowing the stop error and recording success anyway was the bug here: the
 * evidence would claim cleanup that never happened. The stop has to be
 * confirmed by the instance actually going offline, and a failure is a failure.
 */
async function stopIfOurs(owned) {
    if (!owned?.port) return;

    // Ask again, immediately before the POST. Between deciding to clean up and
    // sending the request the world can change, and the thing we would be
    // stopping might no longer be ours.
    const before = await observePort(owned.port);
    const decision = cleanupDecision(owned, before);
    if (decision.action !== 'stop') {
        report.cleanup = { port: owned.port, stopped: decision.action === 'none', decision };
        if (decision.action === 'refuse') {
            failures.push('cleanup-could-not-prove-ownership');
            console.error(`FAIL cleanup-could-not-prove-ownership  ${decision.reason}`);
            return;   // journal stays for a human
        }
        report.startedAndStopped = owned.port;
        await rm(JOURNAL, { force: true }).catch(() => {});
        return;
    }

    let stopped = false;
    let detail = null;
    try {
        const res = await fetch(`${origin}/api/dashboard/lifecycle/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ port: owned.port }),
            signal: AbortSignal.timeout(30_000),
        });
        detail = res.ok ? null : `HTTP ${res.status}`;
        for (let i = 0; i < 12 && !stopped; i += 1) {
            await new Promise((r) => setTimeout(r, 1200));
            const now = await observePort(owned.port);
            const confirmed = stopConfirmed(now);
            stopped = confirmed.done;
            detail = confirmed.reason;
        }
    } catch (error) {
        detail = String(error.message).slice(0, 90);
    }

    report.cleanup = { port: owned.port, stopped, detail };
    if (!stopped) {
        failures.push('cleanup-left-an-instance-running');
        console.error(`FAIL cleanup-left-an-instance-running  ${JSON.stringify(report.cleanup)}`);
        return;   // journal stays on disk for the next run to pick up
    }
    report.startedAndStopped = owned.port;
    await rm(JOURNAL, { force: true }).catch(() => {});
}

/**
 * Stop anything a previous run started and could not clean up.
 *
 * Returns 'clean' when there is nothing to do or the orphan was stopped, and
 * 'blocked' when something needs a human. Stopping the wrong instance is worse
 * than leaving one running, so anything ambiguous refuses to act:
 *
 *  - `phase: 'intent'` means the start may never have happened; a later
 *    instance on that port belongs to whoever started it.
 *  - a different manager pid means the manager restarted, and the port's
 *    current occupant has nothing to do with our run.
 *  - a different instance pid means the process we started is already gone and
 *    something else took the port.
 */
async function recoverOrphans() {
    let journal = null;
    try {
        journal = JSON.parse(await readFile(JOURNAL, 'utf8'));
    } catch (error) {
        // Distinguish "no journal" from "a journal we cannot read". The second
        // means something claimed ownership and we cannot tell what, which is
        // exactly when guessing is dangerous.
        if (error?.code === 'ENOENT') return 'clean';
        journal = 'unreadable';
    }

    const port = journal === 'unreadable' ? null : journal?.port;
    const observed = Number.isInteger(port) ? await observePort(port) : null;
    const decision = recoveryDecision(journal, observed, origin);
    report.identity.recoveryDecision = decision;

    if (decision.action === 'none') {
        if (journal !== 'unreadable') await rm(JOURNAL, { force: true }).catch(() => {});
        return 'clean';
    }
    if (decision.action === 'refuse') {
        console.error(`[wplive] not touching anything: ${decision.reason}`);
        console.error(`         inspect ${JOURNAL} and remove it once you are satisfied.`);
        return 'blocked';
    }

    console.error(`[wplive] a previous run left :${journal.port} running (${decision.reason}); stopping it`);
    await stopIfOurs({ port: journal.port, managerPid: journal.managerPid, instancePid: journal.instancePid });
    return report.cleanup?.stopped ? 'clean' : 'blocked';
}

/** Ctrl-C and SIGTERM do not run `finally`, so clean up explicitly. */
function armSignalCleanup() {
    if (armSignalCleanup.armed) return;
    armSignalCleanup.armed = true;
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, async () => {
            console.error(`\n[wplive] ${sig} — stopping the instance this run started`);
            await stopIfOurs(ownership());
            process.exit(130);
        });
    }
}

async function save() {
    if (!outPath) return;
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`[wplive] wrote ${outPath}`);
}

report.failures = failures;
await save();

if (failures.length) {
    console.error(`\nFAIL: ${failures.length} live check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
}
console.error(`\nOK: ${Object.keys(report.checks).length} live checks passed against ${origin}`
    + ` (identity: ${report.identity.verdict})`);
