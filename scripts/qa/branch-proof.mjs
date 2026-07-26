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
            // The observation happens HERE, from the entry's declared selector
            // and the manifest's own words. Nothing from the coverage file is
            // executed in the page, so an entry cannot assert `true`.
            const seen = await page.evaluate(({ selector, absent, requires }) => {
                const el = document.querySelector(selector);
                return {
                    found: Boolean(el),
                    text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
                    absentPresent: absent ? Boolean(document.querySelector(absent)) : false,
                    requiresPresent: requires ? Boolean(document.querySelector(requires)) : true,
                };
            }, { selector: entry.selector, absent: entry.absent ?? null, requires: entry.requires ?? null });

            const verdict = judge(entry, seen);
            results.push({ ...ident(entry), ok: verdict.ok, why: verdict.why, saw: seen.text.slice(0, 120) });
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

/**
 * Does what the page showed match what this branch is supposed to render?
 *
 * The expected copy comes from the ledger, so this cannot be satisfied by
 * anything written in the coverage file itself.
 */
function judge(entry, seen) {
    if (!seen.found) return { ok: false, why: `nothing matched ${entry.selector}` };
    if (seen.absentPresent) return { ok: false, why: `${entry.absent} was present, so this is the neighbouring branch` };
    if (!seen.requiresPresent) return { ok: false, why: `${entry.requires} was missing, so this is a different panel` };
    if (entry.pattern) {
        return new RegExp(entry.pattern).test(seen.text)
            ? { ok: true, why: null }
            : { ok: false, why: `"${seen.text.slice(0, 60)}" does not match /${entry.pattern}/` };
    }
    const expected = entry.expected;
    if (!expected) return { ok: false, why: 'no expected copy for this branch' };
    const hit = entry.match === 'exact' ? seen.text === expected : seen.text.includes(expected);
    return hit
        ? { ok: true, why: null }
        : { ok: false, why: `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen.text.slice(0, 60))}` };
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
if (status.underspecified?.length) {
    console.error(`\nFAIL: ${status.underspecified.length} entries do not say what they expect to see: ${status.underspecified.join(', ')}`);
}
if (failed.length) console.error(`\nFAIL: ${failed.length} of ${results.length} branches did not render as claimed`);

if (failed.length || status.uncovered.length || status.stale.length || status.underspecified?.length) process.exit(1);
console.error(`\nOK: ${results.length}/${status.integration} integration branches proven (${status.total - status.integration} shadowed, excluded by audit)`);
