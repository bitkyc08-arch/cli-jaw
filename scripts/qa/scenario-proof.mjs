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
import { featureScenarioStatus } from './scenario-feature-ledger.mjs';
import { openFixture, startFixtureServer } from './fixture-lib.mjs';

const args = process.argv.slice(2);
const outPath = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

// The runner is surface-agnostic: it merges every registered scenario ledger
// and drives each row through whatever lever and actions the row declares.
// The code tab and the feature tabs share it because the hard part — actions,
// request oracles, wait-for-the-claim — is not specific to either.
const ledgers = [scenarioLedgerStatus(), featureScenarioStatus()];
const malformed = ledgers.flatMap(l => l.malformed);
const duplicate = ledgers.flatMap(l => l.duplicate);
if (malformed.length || duplicate.length) {
    for (const problem of malformed) console.error(`LEDGER ${problem}`);
    for (const id of duplicate) console.error(`LEDGER duplicate scenario id ${id}`);
    process.exit(1);
}
const status = {
    total: ledgers.reduce((a, l) => a + l.total, 0),
    integration: ledgers.reduce((a, l) => a + l.integration, 0),
    shadowed: ledgers.reduce((a, l) => a + l.shadowed, 0),
    withActions: ledgers.reduce((a, l) => a + l.withActions, 0),
    withRequestOracle: ledgers.reduce((a, l) => a + l.withRequestOracle, 0),
    integrationScenarios: ledgers.flatMap(l => l.integrationScenarios),
};

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
        case 'select': {
            const target = page.locator(action.selector).nth(action.nth ?? 0);
            await target.waitFor({ state: 'visible', timeout: 5_000 });
            await target.selectOption(action.value);
            return;
        }
        case 'check': {
            // A visually-hidden checkbox (`.d2-schedule-switch` styles the
            // label, not the input) cannot take a pointer click but still
            // toggles programmatically, and `check` handles hidden inputs.
            const target = page.locator(action.selector).first();
            await target.waitFor({ state: 'attached', timeout: 5_000 });
            await target.check({ force: true, timeout: 5_000 });
            return;
        }
        case 'press': {
            // A keyboard shortcut with modifiers, e.g. Cmd+P for the notes
            // quick switcher (notes-shortcuts.ts).
            const modifiers = [action.meta && 'Meta', action.shift && 'Shift', action.ctrl && 'Control'].filter(Boolean);
            await page.keyboard.press([...modifiers, action.key].join('+'));
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
                // Explicit suffix match, chosen where the prefix carries an id
                // the scenario does not want to pin.
                if (!entry.pathname.endsWith(want.pathEndsWith)) return false;
            } else {
                // An exact path must match exactly. Falling back to a suffix
                // match lets `/sessions/load` satisfy a `/sessions` assertion
                // and `/model` satisfy a `/prompt` one — a request to the
                // wrong endpoint proving the right one, which is the failure
                // this oracle exists to rule out.
                if (entry.pathname !== want.path) return false;
            }
            if (want.query !== undefined) {
                const search = entry.search.startsWith('?') ? entry.search.slice(1) : entry.search;
                if (search !== want.query) return false;
            }
            if (want.bodyIncludes) {
                // Exact equality, not a subset. A subset match lets a request
                // carrying an unexpected field — a stale modelId, an extra
                // cwd — satisfy the oracle while doing something the scenario
                // never authorised.
                const body = entry.body ?? {};
                const wanted = want.bodyIncludes;
                const sentKeys = Object.keys(body).sort();
                const wantKeys = Object.keys(wanted).sort();
                if (sentKeys.length !== wantKeys.length
                    || sentKeys.some((key, i) => key !== wantKeys[i] || body[key] !== wanted[key])) {
                    return false;
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
        const fieldEl = s.field ? document.querySelector(s.field) : null;
        return {
            found: Boolean(el),
            text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            absentPresent: s.absent ? Boolean(document.querySelector(s.absent)) : false,
            requiresPresent: s.requires ? Boolean(document.querySelector(s.requires)) : true,
            draft: draftEl instanceof HTMLTextAreaElement ? draftEl.value : null,
            fieldValue: fieldEl instanceof HTMLInputElement || fieldEl instanceof HTMLSelectElement || fieldEl instanceof HTMLTextAreaElement ? fieldEl.value : null,
            confirmCalls: (window.__jawConfirmCalls ?? []).slice(),
        };
    }, {
        selector: scenario.selector,
        absent: scenario.absent ?? null,
        requires: scenario.requires ?? null,
        field: scenario.field ?? null,
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
    if (scenario.fieldEquals !== undefined && seen.fieldValue !== scenario.fieldEquals) {
        return `field ${scenario.field} was ${JSON.stringify(seen.fieldValue)}, expected ${JSON.stringify(scenario.fieldEquals)}`;
    }
    if (scenario.expectConfirm !== undefined) {
        const calls = seen.confirmCalls ?? [];
        const hit = calls.some(c => c.includes(scenario.expectConfirm));
        if (!hit) return `confirm() was not asked ${JSON.stringify(scenario.expectConfirm)} (saw ${calls.length} calls)`;
    }
    return null;
}

try {
    for (const scenario of status.integrationScenarios) {
        if (only && scenario.id !== only) continue;
        // A scenario may pin a viewport: the board collapses to a compact
        // single-lane picker below 420px and only shows every lane at a wide
        // width, which changes what its rows can assert.
        const { browser, page } = await openFixture(server.url, {
            historyCount: 10,
            ...(scenario.viewport ? { viewport: scenario.viewport } : {}),
            ...(scenario.noSession ? { autoSelectSession: false } : {}),
        });
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
            // Apply each lever the row declares. A lever the harness does not
            // implement fails here by name rather than measuring the default
            // screen.
            for (const [lever, value] of Object.entries(scenario.levers ?? {})) {
                await page.evaluate(([name, config]) => {
                    const setter = window.__jawE2E[`set${name[0].toUpperCase() + name.slice(1)}`];
                    const resetter = window.__jawE2E[`reset${name[0].toUpperCase() + name.slice(1)}`];
                    if (typeof setter !== 'function') throw new Error(`harness has no set${name} lever`);
                    resetter?.();
                    setter(config);
                }, [lever, value]);
            }
            if (scenario.dropWorkingDir) await page.evaluate(() => window.__jawE2E.setDropWorkingDir(true));

            if (scenario.openSettings) {
                // The settings workspace replaces the chat area rather than
                // opening in the side pane.
                await page.evaluate(() => window.__jawE2E.setSettings());
            } else if (scenario.openDock) {
                // The hover dock opens from its workbench-header trigger, then
                // a tab is chosen. The three tabs share one snapshot DOM, so
                // every dock selector is scoped to [data-dock-tab].
                await page.locator('.hover-dock-trigger').click();
                if (scenario.dockTab) {
                    await page.locator(`.hover-dock-tab[role="tab"]:has-text("${scenario.dockTab}")`).click();
                }
            } else {
                await page.evaluate((panel) => window.__jawE2E.openPanel(panel), scenario.panel ?? 'code');
            }
            await page.locator(scenario.waitFor ?? '.d2-code-tab, .d2-code-gate').first().waitFor({ timeout: 15_000 });

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
            // All requests, not a per-surface subset: the oracle's path filter
            // is what scopes the claim, so a board/notes/schedule request must
            // be visible here just as a code one is.
            const sent = await page.evaluate((since) => window.__jawE2E.allRequests(since), mark);
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
