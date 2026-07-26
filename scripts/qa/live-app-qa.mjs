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
    let settled = hash === evidence.instanceSnapshotHash;
    for (let attempt = 0; !settled && attempt < 3; attempt += 1) {
        await new Promise((r) => setTimeout(r, 1200));
        const next = snapshotHash((await getJson('/api/dashboard/instances')).instances ?? []);
        settled = next === hash;   // stable across two reads is good enough
        hash = next;
    }
    report.identity.snapshot = { evidence: evidence.instanceSnapshotHash, runner: hash, settled };
    report.identity.verdict = settled ? 'aligned' : 'unstable';
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
    const ctasUsable = rows.startCtas.length > 0 && rows.startCtas.every((c) => c.label?.startsWith('Start'));
    record('offline-rows-are-not-dead-buttons',
        rows.deadButtons === 0 && rows.offlineInTabOrder === 0 && ctasUsable,
        { deadButtons: rows.deadButtons, statusElements: rows.statusElements,
          offlineInTabOrder: rows.offlineInTabOrder, startCtas: rows.startCtas.length });

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

    // ── 3. the sidebar scrolls ──────────────────────────────────────────────
    //
    // Observed as a gesture, not as accessibility-tree order. The sidebar is
    // not virtualized, so a full AX tree keeps offscreen children in document
    // order — the first child staying put proves nothing.
    const scroll = await page.evaluate(() => {
        const el = document.querySelector('.d2-sidebar-list');
        return el ? { before: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
    });
    if (!scroll || scroll.scrollHeight <= scroll.clientHeight) {
        record('sidebar-scrolls-on-wheel', true, { skipped: 'nothing to scroll', ...scroll });
    } else {
        const box = await page.locator('.d2-sidebar-list').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => document.querySelector('.d2-sidebar-list').scrollTop);
        record('sidebar-scrolls-on-wheel', after !== scroll.before,
            { before: scroll.before, after, delta: after - scroll.before });
    }

    // ── 4. nothing is a dead control anywhere on the shell ──────────────────
    //
    // Generalises symptom 1: a control that is enabled, visible and clipped out
    // of reach, or one that is disabled with no explanation beside it, reads to
    // a user as "the app is broken".
    const deadControls = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, [role="button"], [role="tab"]')) {
            if (!el.disabled) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            if (el.closest('[inert], [aria-hidden="true"]')) continue;
            // A disabled control is fine when something explains it.
            const explained = el.getAttribute('title') || el.getAttribute('aria-describedby');
            if (!explained) out.push((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40));
        }
        return out;
    });
    record('no-unexplained-disabled-controls', deadControls.length === 0,
        { count: deadControls.length, sample: deadControls.slice(0, 6) });
} finally {
    await browser.close();
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
