#!/usr/bin/env node
// wp5a — run the branch coverage map and prove each branch actually renders.
//
// The ledger is a claim and the coverage map is a plan. This executes it: for
// every integration branch, open its surface in its state and evaluate the
// proof predicate in the page. A branch whose fixture quietly falls back to the
// happy screen fails here by name, which is what the previous "28 branches,
// 100 rows" phrasing could never do.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { branchCoverageStatus } from './branch-coverage.mjs';
import { FIXTURE_STATES, FIXTURE_SURFACES, openFixture, startFixtureServer } from './fixture-lib.mjs';

const args = process.argv.slice(2);
const outPath = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();

const status = branchCoverageStatus();
const results = [];
const server = await startFixtureServer();

try {
    for (const entry of status.entries) {
        const surface = FIXTURE_SURFACES[entry.surface];
        const state = FIXTURE_STATES[entry.state];
        if (!surface || !state) {
            results.push({ ...ident(entry), ok: false, why: `unknown surface/state ${entry.surface}/${entry.state}` });
            continue;
        }
        const { browser, page } = await openFixture(server.url, {
            historyCount: 10,
            ...(state.needsBridge ? { desktopBridge: state.needsBridge } : {}),
            ...(state.noSession ? { autoSelectSession: false } : {}),
        });
        try {
            await state.pre?.(page);
            await surface.reach(page);
            const applied = entry.state === 'default' ? 1 : await state.apply(page, surface.root);
            if (!applied) {
                results.push({ ...ident(entry), ok: false, why: 'state did not apply to this surface' });
                continue;
            }
            // The predicate is serialised into the page, so it must be
            // self-contained: no closure over anything in this file.
            const proven = await page.evaluate(`(${entry.proof.toString()})()`);
            results.push({ ...ident(entry), ok: Boolean(proven), why: proven ? null : 'proof predicate was false' });
        } catch (error) {
            results.push({ ...ident(entry), ok: false, why: String(error?.message ?? error).split('\n')[0].slice(0, 160) });
        } finally {
            await browser.close();
        }
    }
} finally {
    await server.close();
}

function ident(entry) {
    return { id: entry.id, component: entry.component, axis: entry.axis, surface: entry.surface, state: entry.state };
}

for (const r of results) {
    console.error(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} <- ${r.surface}/${r.state}${r.ok ? '' : `  (${r.why})`}`);
}

const failed = results.filter(r => !r.ok);
const report = {
    when: new Date().toISOString(),
    total: status.total,
    integration: status.integration,
    proven: results.length - failed.length,
    uncovered: status.uncovered,
    stale: status.stale,
    results,
};
if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`wrote ${outPath}`);
}

if (status.uncovered.length) {
    console.error(`\nFAIL: ${status.uncovered.length} integration branches have no fixture: ${status.uncovered.join(', ')}`);
}
if (status.stale.length) {
    console.error(`\nFAIL: ${status.stale.length} coverage entries name branches the manifest no longer has: ${status.stale.join(', ')}`);
}
if (status.mismatched?.length) {
    console.error(`\nFAIL: ${status.mismatched.length} predicates do not assert their own branch's copy:`);
    for (const m of status.mismatched) console.error(`  ${m.id} should assert ${JSON.stringify(m.expected)}`);
}
if (failed.length) console.error(`\nFAIL: ${failed.length} of ${results.length} branches did not render as claimed`);

if (failed.length || status.uncovered.length || status.stale.length || status.mismatched?.length) process.exit(1);
console.error(`\nOK: ${results.length}/${status.integration} integration branches proven (${status.total - status.integration} shadowed, excluded by audit)`);
