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
            if (!root) return { error: 'surface root not found', total: 0, names: [] };
            const els = [...root.querySelectorAll(focusable)]
                .filter((el) => !el.hasAttribute('disabled') && el.getBoundingClientRect().width > 0);
            const label = (el) => el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.tagName;
            return { total: els.length, names: els.map(label) };
        }, { rootSelector: surface.root ?? null, focusable: FOCUSABLE });

        const seen = new Set();
        // Three passes worth of Tab so a roving-tabindex group still gets a
        // chance to expose each of its members.
        for (let step = 0; step < Math.max(inventory.total * 3, 20); step += 1) {
            await page.keyboard.press('Tab');
            const active = await page.evaluate((rootSelector) => {
                const el = document.activeElement;
                const root = rootSelector ? document.querySelector(rootSelector) : document.body;
                if (!el || !root || !root.contains(el)) return null;
                return el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.tagName;
            }, surface.root ?? null);
            if (active) seen.add(active);
        }

        const unreachable = inventory.names.filter((name) => !seen.has(name));
        payload = {
            mode, surface: surfaceName, owner: surface.owner,
            total: inventory.total, reached: seen.size, unreachable,
            verdict: inventory.error ? 'fail' : (unreachable.length === 0 ? 'pass' : 'fail'),
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
