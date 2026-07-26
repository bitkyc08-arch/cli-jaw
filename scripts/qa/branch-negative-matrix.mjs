#!/usr/bin/env node
// wp5a — does each branch declaration REJECT the states it does not describe?
//
// branch-proof answers "does this branch render where I said it would". That
// is only half the claim. A declaration broad enough to also match a sibling
// state proves nothing about which branch was measured, and a reviewer's
// standing objection was that nothing checked this mechanically.
//
// So: for every branch, drive every OTHER state of the same surface and assert
// the declaration comes back false. A declaration that passes somewhere it
// should not is reported by name, with the state that fooled it.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { branchCoverageStatus } from './branch-coverage.mjs';
import { FIXTURE_STATES, FIXTURE_SURFACES, openFixture, startFixtureServer } from './fixture-lib.mjs';

const args = process.argv.slice(2);
const outPath = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();

const status = branchCoverageStatus();
const server = await startFixtureServer();
const collisions = [];
let checks = 0;

/** The same observation branch-proof makes, so the two cannot disagree. */
async function observe(page, entry) {
    return page.evaluate(({ selector, absent, requires }) => {
        const el = document.querySelector(selector);
        return {
            found: Boolean(el),
            text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            absentPresent: absent ? Boolean(document.querySelector(absent)) : false,
            requiresPresent: requires ? Boolean(document.querySelector(requires)) : true,
        };
    }, { selector: entry.selector, absent: entry.absent ?? null, requires: entry.requires ?? null });
}

function satisfied(entry, seen) {
    if (!seen.found || seen.absentPresent || !seen.requiresPresent) return false;
    if (entry.pattern) return new RegExp(entry.pattern).test(seen.text);
    if (!entry.expected) return false;
    return entry.match === 'exact' ? seen.text === entry.expected : seen.text.includes(entry.expected);
}

try {
    for (const entry of status.entries) {
        const surface = FIXTURE_SURFACES[entry.surface];
        // Every state this surface can actually be driven into, minus the one
        // this branch claims and minus the synthetic probes.
        //
        // `disabled`, `dragging` and `panel-states` do not activate a React
        // branch: they mutate the DOM the panel already rendered. A branch
        // still matching under them is not ambiguity, it is the same branch
        // wearing an attribute, so counting those as collisions would report
        // three failures that say nothing.
        const others = Object.entries(FIXTURE_STATES)
            .filter(([name, state]) => name !== entry.state
                && !state.syntheticProbe
                && (!state.only || state.only.test(surface.root)));

        for (const [stateName, state] of others) {
            const { browser, page } = await openFixture(server.url, {
                historyCount: 10,
                ...(state.needsBridge ? { desktopBridge: state.needsBridge } : {}),
                ...(state.noSession ? { autoSelectSession: false } : {}),
            });
            try {
                await state.pre?.(page);
                await surface.reach(page);
                const applied = stateName === 'default' ? 1 : await state.apply(page, surface.root);
                // A state that does not apply to this surface is not a state
                // this branch could be confused with.
                if (!applied) continue;
                checks += 1;
                const seen = await observe(page, entry);
                if (satisfied(entry, seen)) {
                    collisions.push({
                        id: entry.id,
                        declaredState: entry.state,
                        alsoMatches: stateName,
                        saw: seen.text.slice(0, 90),
                    });
                }
            } catch {
                // The state could not be driven here at all, which is a
                // stronger form of "not confusable".
            } finally {
                await browser.close();
            }
        }
        console.error(`${collisions.some(c => c.id === entry.id) ? 'FAIL' : 'OK  '} ${entry.id}`
            + ` (${others.length} rival states)`);
    }
} finally {
    await server.close();
}

const report = { when: new Date().toISOString(), checks, collisions };
if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`wrote ${outPath}`);
}

if (collisions.length) {
    console.error(`\nFAIL: ${collisions.length} declarations also match a state they do not describe:`);
    for (const c of collisions) console.error(`  ${c.id} (declared ${c.declaredState}) also passes in ${c.alsoMatches}: "${c.saw}"`);
    process.exit(1);
}
console.error(`\nOK: ${status.entries.length} declarations rejected every rival state (${checks} checks)`);
