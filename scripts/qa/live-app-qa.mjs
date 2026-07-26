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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

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

        await page.locator('.d2-workbench-divider-drag').focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(500);
        const afterKeys = await paneWidth();

        record('workbench-divider-actually-resizes',
            afterDrag !== startWidth && afterKeys !== afterDrag,
            { startWidth, afterDrag, afterKeys });
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

    // ── 4. nothing is a dead control anywhere on the shell ──────────────────
    //
    // The generalisation of symptom 1, narrowed after review. "Disabled with no
    // title" was the wrong rule: the composer's model picker is disabled with
    // aria-label="Provider and model unavailable", which states its reason
    // perfectly well, and it would have failed. A single disabled control is
    // ordinary UI. What made the app look broken was that EVERY control in a
    // list was one.
    const deadRuns = await page.evaluate(() => {
        const named = (el) => (el.getAttribute('aria-label') || el.title || el.textContent || '').trim();
        const runs = [];
        for (const list of document.querySelectorAll('.d2-sidebar-list, .d2-side-pane-tab-group, [role="tablist"]')) {
            const controls = [...list.querySelectorAll('button, [role="button"], [role="tab"]')]
                .filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; })
                .filter((el) => !el.closest('[inert], [aria-hidden="true"]'));
            if (controls.length < 3) continue;
            const disabled = controls.filter((el) => el.disabled);
            if (disabled.length === controls.length) {
                runs.push({ container: String(list.className).split(' ')[0],
                            controls: controls.length, sample: named(disabled[0]).slice(0, 40) });
            }
        }
        return runs;
    });
    record('no-list-where-every-control-is-disabled', deadRuns.length === 0,
        { runs: deadRuns.length, detail: deadRuns.slice(0, 3) });
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
    let startedByUs = null;

    if (!target) {
        const candidate = instances.find((i) => i.lifecycle?.canStart);
        if (!candidate) {
            record('sidebar-scrolls-after-selection', false,
                { unavailable: 'no online instance and none can be started' });
            return;
        }
        await fetch(`${origin}/api/dashboard/lifecycle/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ port: candidate.port }),
            signal: AbortSignal.timeout(30_000),
        });
        startedByUs = candidate.port;
        for (let i = 0; i < 20 && !target; i += 1) {
            await new Promise((r) => setTimeout(r, 1500));
            const fresh = (await getJson('/api/dashboard/instances')).instances ?? [];
            target = fresh.find((x) => x.port === candidate.port && x.status === 'online');
        }
        if (!target) {
            record('sidebar-scrolls-after-selection', false,
                { unavailable: `instance ${candidate.port} never came online` });
            await stopIfOurs(startedByUs);
            return;
        }
    }

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
        if (sessions.length > 1) {
            await page.locator('.d2-session-row').first().click({ timeout: 10_000 });
            await page.waitForTimeout(1200);
        }

        // Prove the state rather than trusting the click.
        const selection = await page.evaluate(() => ({
            selectedRows: document.querySelectorAll('.d2-session-row.is-selected').length,
            chatView: Boolean(document.querySelector('[data-testid="chat-view"]')),
            title: document.querySelector('.d2-workbench-title')?.textContent?.trim() ?? null,
        }));
        const inSelectedState = selection.chatView || selection.selectedRows > 0;
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
        await stopIfOurs(startedByUs);
    }
}

/** Undo only what this run started. A pre-existing instance is left running. */
async function stopIfOurs(port) {
    if (!port) return;
    await fetch(`${origin}/api/dashboard/lifecycle/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
    report.startedAndStopped = port;
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
