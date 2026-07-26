#!/usr/bin/env node
// wp5b — execute the code-tab scenario ledger against the real React tree.
//
// branch-proof answers "does this branch render where the map says". That is a
// screen question, and half of this tab's states are not screen questions:
// Stop sends a cancel and repaints nothing, retry is only distinguishable by
// the request it makes, and a prompt that "worked" is one whose draft went
// away. So this runner adds two things branch-proof does not have:
//
//   actions        performed in order, each one a hard failure if it cannot
//                  be performed — a missed click that lands on a lucky screen
//                  must not read as a pass
//   expectRequests compared against the requests recorded DURING the actions,
//                  with exact counts including zero
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scenarioLedgerStatus } from './scenario-ledger.mjs';
import { openFixture, startFixtureServer } from './fixture-lib.mjs';

const args = process.argv.slice(2);
const outPath = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

const status = scenarioLedgerStatus();
if (status.malformed.length || status.duplicate.length) {
    for (const problem of status.malformed) console.error(`LEDGER ${problem}`);
    for (const id of status.duplicate) console.error(`LEDGER duplicate scenario id ${id}`);
    process.exit(1);
}

const server = await startFixtureServer();
const results = [];

/** Drive one action, throwing with the scenario's own words on failure. */
async function perform(page, action) {
    switch (action.kind) {
        case 'click': {
            const target = page.locator(action.selector).first();
            await target.waitFor({ state: 'visible', timeout: 5_000 });
            await target.click({ timeout: 5_000 });
            return;
        }
        case 'type': {
            const target = page.locator(action.selector).first();
            await target.waitFor({ state: 'visible', timeout: 5_000 });
            await target.fill(action.text);
            return;
        }
        case 'pick-model': {
            // Scoped to the code tab's own control. The chat composer renders
            // a model picker too, and an unscoped `.first()` drove THAT one —
            // every model scenario then timed out waiting for a menu that had
            // opened somewhere else on the page.
            const control = page.locator('.d2-code-model-control');
            await control.locator('.d2-model-picker-trigger').first().click({ timeout: 5_000 });
            const option = control.locator('.d2-model-picker-option', { hasText: action.value }).first();
            await option.waitFor({ state: 'visible', timeout: 5_000 });
            await option.click({ timeout: 5_000 });
            return;
        }
        case 'permission': {
            // Permissions arrive only over the jwc SSE topic, and only on the
            // WORKER channel (`/i/<port>/api/events`); the manager stream does
            // not carry them (sync-provider.tsx:334).
            await page.evaluate(({ requestId, sessionId }) => {
                window.__jawE2E.sse.emit(`/i/3506/api/events`, {
                    topic: 'jwc',
                    event: 'code_permission_request',
                    sessionId,
                    id: requestId,
                    requestId,
                    options: [
                        { optionId: 'allow-once', name: 'Allow once' },
                        { optionId: 'reject', name: 'Reject' },
                    ],
                });
            }, { requestId: action.requestId, sessionId: action.sessionId });
            // The prompt lands through a React state update.
            await page.waitForTimeout(150);
            return;
        }
        case 'wait': {
            await page.locator(action.selector).first().waitFor({ timeout: 5_000 });
            return;
        }
        default:
            throw new Error(`unknown action ${action.kind}`);
    }
}

/** Exact-count comparison of what the page actually sent. */
function judgeRequests(scenario, sent) {
    const problems = [];
    for (const want of scenario.expectRequests ?? []) {
        const matched = sent.filter((entry) => {
            if (entry.method !== want.method) return false;
            if (want.pathEndsWith) {
                if (!entry.pathname.endsWith(want.pathEndsWith)) return false;
            } else if (entry.pathname !== want.path && !entry.pathname.endsWith(want.path)) {
                return false;
            }
            if (want.query !== undefined) {
                const search = entry.search.startsWith('?') ? entry.search.slice(1) : entry.search;
                if (search !== want.query) return false;
            }
            if (want.bodyIncludes) {
                const body = entry.body ?? {};
                for (const [key, value] of Object.entries(want.bodyIncludes)) {
                    if (body[key] !== value) return false;
                }
            }
            return true;
        });
        if (matched.length !== want.count) {
            const label = want.pathEndsWith ? `*${want.pathEndsWith}` : want.path;
            problems.push(`expected ${want.count}x ${want.method} ${label}`
                + `${want.bodyIncludes ? ` ${JSON.stringify(want.bodyIncludes)}` : ''}`
                + `, saw ${matched.length}`);
        }
    }
    return problems;
}

/** Everything the page can tell us about this scenario's claim. */
async function observe(page, scenario) {
    return page.evaluate((s) => {
        const el = document.querySelector(s.selector);
        const draftEl = document.querySelector('.d2-code-composer textarea');
        return {
            found: Boolean(el),
            text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            absentPresent: s.absent ? Boolean(document.querySelector(s.absent)) : false,
            requiresPresent: s.requires ? Boolean(document.querySelector(s.requires)) : true,
            draft: draftEl instanceof HTMLTextAreaElement ? draftEl.value : null,
        };
    }, {
        selector: scenario.selector,
        absent: scenario.absent ?? null,
        requires: scenario.requires ?? null,
    });
}

function judgeDom(scenario, seen) {
    if (!seen.found) return `nothing matched ${scenario.selector}`;
    if (seen.absentPresent) return `${scenario.absent} was present, so this is a neighbouring state`;
    if (!seen.requiresPresent) return `${scenario.requires} was missing, so this is a different screen`;
    if (scenario.pattern && !new RegExp(scenario.pattern, 's').test(seen.text)) {
        return `"${seen.text.slice(0, 70)}" does not match /${scenario.pattern}/`;
    }
    if (scenario.expected && !seen.text.includes(scenario.expected)) {
        return `expected ${JSON.stringify(scenario.expected)}, saw ${JSON.stringify(seen.text.slice(0, 70))}`;
    }
    if (scenario.draftEquals !== undefined && seen.draft !== scenario.draftEquals) {
        return `draft was ${JSON.stringify(seen.draft)}, expected ${JSON.stringify(scenario.draftEquals)}`;
    }
    return null;
}

try {
    for (const scenario of status.integrationScenarios) {
        if (only && scenario.id !== only) continue;
        const { browser, page } = await openFixture(server.url, { historyCount: 10 });
        try {
            if (scenario.chunkDelay) {
                // The harness replaces window.fetch, which a dynamic import
                // never goes through, so the lazy module is delayed at the
                // network layer instead.
                //
                // The fixture serves through Vite in dev mode, so the request
                // is for `CodeTab.tsx`, not a built `.js` chunk. Matching only
                // `*.js` silently delayed nothing and the fallback frame was
                // over before the observation began.
                await page.route('**/CodeTab.tsx*', async (route) => {
                    await new Promise(resolve => setTimeout(resolve, 4_000));
                    await route.continue();
                });
            }
            await page.evaluate((cfg) => {
                window.__jawE2E.resetCode();
                window.__jawE2E.setCode(cfg);
            }, scenario.code ?? {});
            if (scenario.dropWorkingDir) await page.evaluate(() => window.__jawE2E.setDropWorkingDir(true));

            await page.evaluate(() => window.__jawE2E.openPanel('code'));
            await page.locator('.d2-code-tab, .d2-code-gate').first().waitFor({ timeout: 15_000 });

            // Mark AFTER mount so the oracle sees only what the actions caused.
            const mark = await page.evaluate(() => window.__jawE2E.markRequests());
            for (const action of scenario.actions ?? []) await perform(page, action);

            // Wait for the CLAIM, not a fixed delay: these states arrive
            // through a promise plus a React commit, so observing immediately
            // measures the frame before the one under test. Each wait below
            // fails soft — judgeDom then reports the miss in the scenario's own
            // words instead of a bare timeout.
            await page.locator(scenario.selector).first()
                .waitFor({ state: 'attached', timeout: 6_000 })
                .catch(() => {});
            // An absence claim needs its own wait: the element it forbids may
            // still be on its way out.
            if (scenario.absent) {
                await page.locator(scenario.absent).first()
                    .waitFor({ state: 'detached', timeout: 6_000 })
                    .catch(() => {});
            }
            // Likewise a draft assertion: clearing the box is a state update
            // that lands after the request resolves.
            if (scenario.draftEquals !== undefined) {
                await page.waitForFunction((want) => {
                    const el = document.querySelector('.d2-code-composer textarea');
                    return el instanceof HTMLTextAreaElement && el.value === want;
                }, scenario.draftEquals, { timeout: 6_000 }).catch(() => {});
            }
            // And a copy assertion, for values that change in place (the model
            // label after a switch commits).
            if (scenario.pattern) {
                await page.locator(scenario.selector).first()
                    .filter({ hasText: new RegExp(scenario.pattern) })
                    .waitFor({ state: 'attached', timeout: 6_000 })
                    .catch(() => {});
            }
            const seen = await observe(page, scenario);
            const sent = await page.evaluate((since) => window.__jawE2E.codeRequests(since), mark);
            const domProblem = judgeDom(scenario, seen);
            const requestProblems = judgeRequests(scenario, sent);
            const why = [domProblem, ...requestProblems].filter(Boolean).join('; ');
            results.push({
                id: scenario.id,
                axis: scenario.axis ?? null,
                target: scenario.target ?? null,
                branchId: scenario.branchId ?? null,
                ok: !why,
                ...(why ? { why } : {}),
                saw: seen.text.slice(0, 100),
                ...(scenario.knownDefect ? { knownDefect: scenario.knownDefect } : {}),
            });
        } catch (error) {
            results.push({
                id: scenario.id,
                ok: false,
                why: String(error?.message ?? error).split('\n')[0].slice(0, 180),
            });
        } finally {
            await browser.close();
        }
    }
} finally {
    await server.close();
}

for (const r of results) {
    console.error(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id}${r.ok ? '' : `  (${r.why})`}`);
}

const failed = results.filter(r => !r.ok);
const report = {
    when: new Date().toISOString(),
    total: status.total,
    integration: status.integration,
    shadowed: status.shadowed,
    withActions: status.withActions,
    withRequestOracle: status.withRequestOracle,
    proven: results.length - failed.length,
    results,
};
if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`wrote ${outPath}`);
}

if (failed.length) {
    console.error(`\nFAIL: ${failed.length} of ${results.length} code scenarios did not hold`);
    process.exit(1);
}
console.error(`\nOK: ${results.length}/${status.integration} code scenarios proven`
    + ` (${status.shadowed} shadowed, ${status.withRequestOracle} carrying a request oracle)`);
