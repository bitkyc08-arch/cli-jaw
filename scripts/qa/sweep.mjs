#!/usr/bin/env node
/*
 * M1/M3/M4 gate.
 *
 *   --mode interact  M1: the surface is actually operable (not inert-trapped)
 *   --mode keyboard  M3: every visible enabled control is reachable by Tab
 *   --mode overlay   M4: Escape closes and focus is not dropped on body
 *
 * Usage:
 *   node scripts/qa/sweep.mjs --surface sidebar --mode keyboard --out evidence/wp2.keyboard.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SURFACES, launch, resolveSurface } from './qa-lib.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};

const surfaceName = flag('surface');
const mode = flag('mode');
const outPath = flag('out');
const url = flag('url', 'http://127.0.0.1:24577/dashboard2/');

const MODES = ['interact', 'keyboard', 'overlay'];
if (!surfaceName || !MODES.includes(mode) || !outPath) {
    console.error(`Usage: sweep.mjs --surface <name> --mode <${MODES.join('|')}> --out <path>`);
    console.error(`Known surfaces: ${Object.keys(SURFACES).join(', ')}`);
    process.exit(2);
}

const surface = SURFACES[surfaceName];
if (!surface) {
    console.error(`Unknown surface "${surfaceName}"`);
    process.exit(2);
}

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const { browser, page } = await launch(url);
let payload;
try {
    await resolveSurface(page, surface);

    if (mode === 'keyboard') {
        const inventory = await page.evaluate(({ rootSelector, focusable }) => {
            const root = rootSelector ? document.querySelector(rootSelector) : document.body;
            if (!root) return { error: 'surface root not found', total: 0, names: [], roving: [] };
            const els = [...root.querySelectorAll(focusable)]
                .filter((el) => !el.hasAttribute('disabled') && el.getBoundingClientRect().width > 0);
            const label = (el) => el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.tagName;

            /*
             * Members of a roving-tabindex group are reached with arrow keys, not
             * Tab, so counting them as unreachable is wrong. This produced a false
             * positive on the sidebar mode tabs. Composite widgets keep exactly one
             * tabbable member; the rest carry tabindex="-1" by design.
             */
            const ROVING = { tablist: 'tab', listbox: 'option', menu: 'menuitem', tree: 'treeitem' };
            const roving = [];
            for (const [container, member] of Object.entries(ROVING)) {
                for (const group of root.querySelectorAll(`[role="${container}"]`)) {
                    const members = [...group.querySelectorAll(`[role="${member}"]`)]
                        .filter((el) => !el.hasAttribute('disabled'));
                    if (members.length < 2) continue;
                    const entryPoints = members.filter((el) => el.tabIndex >= 0);
                    for (const el of members) {
                        if (el.tabIndex < 0) roving.push({ name: label(el), group: container });
                    }
                    // A well-formed group has exactly one entry point.
                    if (entryPoints.length !== 1) {
                        roving.push({ name: `${container}: ${entryPoints.length} entry points`, group: container, malformed: true });
                    }
                }
            }
            return { total: els.length, names: els.map(label), roving };
        }, { rootSelector: surface.root ?? null, focusable: FOCUSABLE });

        /*
         * Tab until the focus ring returns to where it started, rather than for a
         * fixed budget.
         *
         * A fixed budget produced 51 false positives on the sidebar: controls that
         * only become focusable once their row has :focus-within are revealed as
         * Tab arrives, so the walk needs to actually finish the cycle. It never
         * did with 50 instance rows in the list. Stopping on wrap-around also
         * makes the result independent of how many rows happen to be present.
         */
        const seen = new Set();
        const readActive = () => page.evaluate((rootSelector) => {
            const el = document.activeElement;
            const root = rootSelector ? document.querySelector(rootSelector) : document.body;
            const label = el ? (el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.tagName) : null;
            return { label, inside: Boolean(el && root && root.contains(el)) };
        }, surface.root ?? null);

        const HARD_CAP = 4000;
        let first = null;
        let wrapped = false;
        for (let step = 0; step < HARD_CAP; step += 1) {
            await page.keyboard.press('Tab');
            const { label, inside } = await readActive();
            if (inside && label) {
                seen.add(label);
                if (first === null) first = label;
                else if (label === first && seen.size > 1 && step > 2) { wrapped = true; break; }
            }
        }

        /*
         * Reachable = landed on by Tab, OR a member of a roving group that Tab is
         * not supposed to visit. Malformed groups stay in the failure list.
         */
        const rovingNames = new Set((inventory.roving ?? []).filter((entry) => !entry.malformed).map((entry) => entry.name));
        const malformed = (inventory.roving ?? []).filter((entry) => entry.malformed);
        const unreachable = inventory.names.filter((name) => !seen.has(name) && !rovingNames.has(name));
        payload = {
            mode, surface: surfaceName, owner: surface.owner,
            total: inventory.total, reached: seen.size, unreachable,
            tabCycleCompleted: wrapped,
            reachableViaRoving: [...rovingNames],
            malformedRovingGroups: malformed,
            verdict: inventory.error ? 'fail'
                : (unreachable.length === 0 && malformed.length === 0 ? 'pass' : 'fail'),
            error: inventory.error,
        };
    } else if (mode === 'overlay') {
        const before = await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => ({
            dialogs: document.querySelectorAll('[role="dialog"]').length,
            focusOnBody: document.activeElement === document.body,
        }));
        payload = {
            mode, surface: surfaceName, owner: surface.owner,
            dialogsBefore: before, dialogsAfter: after.dialogs,
            escapeClosed: after.dialogs < before, focusLost: after.focusOnBody,
            verdict: before === 0 ? 'n/a' : (after.dialogs < before && !after.focusOnBody ? 'pass' : 'fail'),
        };
    } else {
        /*
         * A surface buried in an inert subtree looks fine in a screenshot and
         * is completely dead to the user. That is exactly how the settings
         * modal bug presented, so it gets a first-class check.
         */
        const state = await page.evaluate((rootSelector) => {
            const root = rootSelector ? document.querySelector(rootSelector) : document.body;
            if (!root) return { missing: true };
            const clickable = [...root.querySelectorAll('button:not([disabled]), [role="button"]:not([aria-disabled="true"])')]
                .filter((el) => el.getBoundingClientRect().width > 0)
                .map((el) => el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || 'unnamed');
            return { missing: false, clickable, inInert: Boolean(root.closest('[inert]')) };
        }, surface.root ?? null);

        payload = state.missing
            ? { mode, surface: surfaceName, owner: surface.owner, verdict: 'fail', error: 'surface root not found' }
            : {
                mode, surface: surfaceName, owner: surface.owner,
                clickableCount: state.clickable.length,
                clickable: state.clickable,
                surfaceInInertSubtree: state.inInert,
                consoleErrors: page.consoleErrors,
                verdict: state.inInert ? 'fail' : 'pass',
                note: state.inInert ? 'surface sits inside an inert subtree, so nothing can be clicked' : undefined,
            };
    }
} finally {
    await browser.close();
}

payload.capturedAt = new Date().toISOString();
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`${mode} ${surfaceName}: ${payload.verdict} -> ${outPath}`);
process.exit(payload.verdict === 'fail' ? 1 : 0);
