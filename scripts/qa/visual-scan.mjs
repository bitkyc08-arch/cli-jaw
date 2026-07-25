#!/usr/bin/env node
// wp13 — measure every surface, not just the one that happens to be on screen.
//
// The first survey looked at the default view and concluded "one defect". That
// is only true of the shell: settings, the side pane, notes, the board and the
// hover dock were never rendered, so nothing in them was measured. This walks
// the surface table from qa-lib, opens each one, and reports per surface.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SURFACES, launch, resolveSurface } from './qa-lib.mjs';
import { installMeasure, setTheme, surfacePixelContrast, THEMES } from './visual-lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const outPath = flag('out');
const url = flag('url', 'http://127.0.0.1:24577/dashboard2/');

const MIN_TARGET = 24;      // WCAG 2.2 AA 2.5.8
const MIN_ICON_CONTRAST = 3; // WCAG 1.4.11 non-text

const report = { url, when: new Date().toISOString(), surfaces: {} };
const notReached = [];

for (const name of Object.keys(SURFACES)) {
    report.surfaces[name] = {};
    for (const theme of THEMES) {
        const { browser, page } = await launch(url);
        try {
            // Reach the surface BEFORE switching theme. Setting the attribute
            // first triggers a re-render that swallowed the navigation clicks,
            // and three of six surfaces silently reported "not reached" —
            // which a scan would otherwise have recorded as "no defects".
            await resolveSurface(page, SURFACES[name]).catch(() => {});
            await setTheme(page, theme);
            await page.waitForTimeout(900);
            await installMeasure(page);

            const root = SURFACES[name].root;
            // Contrast comes from rendered pixels, not from a CSSOM guess. The
            // CSSOM path cannot see pseudo-element backdrops, gradients,
            // backdrop-filter or images, and this is the check most likely to be
            // quietly wrong in exactly those places.
            const pixelContrastRows = await surfacePixelContrast(page, root).catch(() => null);

            const measured = await page.evaluate(({ rootSel, minIcon }) => {
                const m = window.__d2measure;
                const scope = document.querySelector(rootSel);
                if (!scope) return { reached: false };
                const within = (el) => scope.contains(el);

                const text = m.textNodes().filter(within);
                const controls = m.controls().filter(within);
                const allControls = m.controls();

                // Kept only as a cross-check against the pixel reading.
                const cssomContrast = [];
                for (const el of text) {
                    const s = getComputedStyle(el);
                    const ratio = m.contrast(m.parseColour(s.color), m.effectiveBackground(el));
                    const need = m.requiredContrast(s);
                    if (ratio < need) cssomContrast.push({ ...m.describe(el), ratio: +ratio.toFixed(2), need });
                }

                // 2.5.8 with its spacing and inline exceptions, not a bare 24px rule.
                const targetFailures = [];
                const targetExempt = [];
                for (const el of controls) {
                    const audit = m.targetAudit(el, allControls);
                    if (audit.ok && audit.reason !== 'meets-24') targetExempt.push({ ...m.describe(el), ...audit });
                    if (!audit.ok) targetFailures.push({ ...m.describe(el), ...audit });
                }

                // Icon-only controls need 3:1 between their glyph and backdrop.
                const iconFailures = [];
                for (const el of controls) {
                    if (el.textContent?.trim()) continue;
                    const svg = el.querySelector('svg');
                    if (!svg) continue;
                    const s = getComputedStyle(el);
                    const ratio = m.contrast(m.parseColour(s.color), m.effectiveBackground(el));
                    if (ratio < minIcon) iconFailures.push({ ...m.describe(el), ratio: +ratio.toFixed(2) });
                }

                // Accessible name per the platform algorithm: a checkbox wrapped
                // in a <label> is named, even with no aria-label.
                const unnamed = controls
                    .filter((el) => !m.accessibleName(el))
                    .map((el) => m.describe(el));

                // Laid out, opaque, and painted over by something else.
                const occluded = [];
                for (const el of controls) {
                    const o = m.occlusion(el);
                    if (o.covered) occluded.push({ ...m.describe(el), coveredBy: o.by });
                }

                // Text clipped by its own box.
                const clipped = text
                    .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')
                    .map((el) => ({ ...m.describe(el), scroll: el.scrollWidth, client: el.clientWidth }));

                const tally = (vals) => {
                    const t = {};
                    for (const v of vals) t[v] = (t[v] ?? 0) + 1;
                    return t;
                };
                const all = [...scope.querySelectorAll('*')].filter(m.isVisible);
                return {
                    reached: true,
                    counts: { text: text.length, controls: controls.length, elements: all.length },
                    cssomContrast,
                    targetFailures,
                    targetExempt,
                    iconFailures,
                    unnamed,
                    occluded,
                    clipped,
                    radii: tally(all.map((el) => getComputedStyle(el).borderTopLeftRadius).filter((v) => v !== '0px')),
                    durations: tally(all.map((el) => getComputedStyle(el).transitionDuration).filter((v) => v !== '0s')),
                    zIndexes: tally(all.map((el) => getComputedStyle(el).zIndex).filter((v) => v !== 'auto')),
                };
            }, { rootSel: root, minIcon: MIN_ICON_CONTRAST });

            const contrastFailures = (pixelContrastRows ?? []).filter((row) => !row.pass);
            report.surfaces[name][theme] = {
                ...measured,
                contrastFailures,
                contrastMeasured: pixelContrastRows?.length ?? 0,
                contrastSource: pixelContrastRows ? 'pixels' : 'unavailable',
            };
            const f = measured.reached
                ? `contrast ${contrastFailures.length}/${pixelContrastRows?.length ?? 0}px, target ${measured.targetFailures.length} (exempt ${measured.targetExempt.length}), icon ${measured.iconFailures.length}, unnamed ${measured.unnamed.length}, occluded ${measured.occluded.length}, clipped ${measured.clipped.length}`
                : 'NOT REACHED';
            console.error(`${name}/${theme}: ${f}`);
            if (!measured.reached) notReached.push(`${name}/${theme}`);
        } finally {
            await browser.close();
        }
    }
}

// A surface that could not be opened has not been shown to be clean. Treating
// "not reached" as "no defects" is how three of six surfaces silently reported
// zero problems in the first run.
report.notReached = notReached;

if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`wrote ${outPath}`);
} else {
    console.log(JSON.stringify(report, null, 2));
}

if (notReached.length) {
    console.error(`\nFAIL: ${notReached.length} surface/theme pairs were never rendered: ${notReached.join(', ')}`);
    process.exit(1);
}
