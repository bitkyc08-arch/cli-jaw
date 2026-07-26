#!/usr/bin/env node
// wp13 B1 — the visual gate, run against deterministic fixtures.
//
// `visual-scan.mjs` measures the live app on :24577, which is useful for
// looking at the real thing but cannot be a gate: its verdict moves with how
// many instances are running and what the sidebar last scrolled to. This runs
// the same oracles against the e2e harness, where the API and SSE are fakes and
// every surface is reached by assertion rather than by sleeping.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FIXTURE_STATES, FIXTURE_SURFACES, openFixture, startFixtureServer } from './fixture-lib.mjs';
import { installMeasure, setTheme, surfaceIconContrast, surfacePixelContrast, THEMES } from './visual-lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const outPath = flag('out');
const reportOnly = args.includes('--report');

const MIN_ICON = 3;
const report = { when: new Date().toISOString(), fixture: 'e2e-app-harness', surfaces: {} };
const notReached = [];
const oracleFailures = [];

const server = await startFixtureServer();

try {
    for (const [name, surface] of Object.entries(FIXTURE_SURFACES)) {
        report.surfaces[name] = {};
        for (const [stateName, state] of Object.entries(FIXTURE_STATES)) {
        for (const theme of THEMES) {
            const key = stateName === 'default' ? theme : `${theme}/${stateName}`;
            const { browser, page } = await openFixture(server.url, {
                historyCount: name === 'workbench' ? 40 : 10,
                // Some states need the bridge injected before the page loads.
                ...(state.needsBridge ? { desktopBridge: state.needsBridge } : {}),
            });
            try {
                // Reaching a surface either works or throws. The live scan used
                // to swallow click failures, which turned an unopened panel into
                // a clean report.
                // Some states must be armed before the surface mounts, because
                // a panel that already has its answer will not ask again.
                await state.pre?.(page);
                await surface.reach(page);
                // States are applied after reaching, because they key off
                // elements that only exist once the surface is open.
                const applied = await state.apply(page, surface.root);
                if (stateName !== 'default' && applied === 0) {
                    // Nothing matched: either the state is stale or the surface
                    // does not have it. Skip rather than report a phantom pass.
                    continue;
                }
                await setTheme(page, theme);
                await page.waitForTimeout(400);
                await installMeasure(page);

                let textRows = null;
                let iconRows = null;
                let oracleError = null;
                try {
                    textRows = await surfacePixelContrast(page, surface.root);
                    await page.waitForTimeout(300);
                    iconRows = await surfaceIconContrast(page, surface.root, MIN_ICON);
                } catch (error) {
                    oracleError = String(error?.message ?? error).slice(0, 200);
                }

                const measured = await page.evaluate(({ rootSel, excludes }) => {
                    const m = window.__d2measure;
                    const scope = document.querySelector(rootSel);
                    if (!scope) return { reached: false };
                    // A parent surface must not re-measure a child that has its
                    // own entry, or the same element is counted twice.
                    const excluded = excludes.flatMap((sel) => [...document.querySelectorAll(sel)]);
                    const outside = (el) => !excluded.some((x) => x.contains(el));
                    const within = (el) => scope.contains(el) && outside(el);

                    const controls = m.controls().filter(within);
                    const all = m.controls();
                    const text = m.textNodes().filter(within);

                    const targetFailures = [];
                    const targetExempt = [];
                    for (const el of controls) {
                        const audit = m.targetAudit(el, all);
                        if (audit.ok && audit.reason !== 'meets-24') targetExempt.push({ ...m.describe(el), ...audit });
                        if (!audit.ok) targetFailures.push({ ...m.describe(el), ...audit });
                    }

                    const unreachable = [];
                    for (const el of scope.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]')) {
                        if (!outside(el)) continue;
                        const verdict = m.unreachableControl(el);
                        if (verdict) unreachable.push(verdict);
                    }

                    return {
                        reached: true,
                        counts: { text: text.length, controls: controls.length },
                        iconOnly: controls.filter((el) => !el.textContent?.trim() && el.querySelector('svg')).length,
                        targetFailures,
                        targetExempt,
                        unreachable,
                        unnamed: controls.filter((el) => !m.accessibleName(el)).map((el) => m.describe(el)),
                        occluded: controls.map((el) => ({ el, o: m.occlusion(el) }))
                            .filter(({ o }) => o.covered)
                            .map(({ el, o }) => ({ ...m.describe(el), coveredBy: o.by })),
                    };
                }, { rootSel: surface.root, excludes: surface.exclude ?? [] });

                if (!measured.reached) { notReached.push(`${name}/${key}`); continue; }

                const contrastFailures = (textRows ?? []).filter((r) => !r.pass && !r.unmeasurable);
                const iconFailures = (iconRows ?? []).filter((r) => !r.pass && !r.unmeasurable);
                const unmeasurable = [...(textRows ?? []), ...(iconRows ?? [])]
                    .filter((r) => r.unmeasurable)
                    .map((r) => ({ cls: r.cls, label: r.label, reason: r.unmeasurable }));

                if (oracleError || textRows === null || iconRows === null) {
                    oracleFailures.push(`${name}/${key}: oracle unavailable${oracleError ? ` (${oracleError})` : ''}`);
                }
                if (textRows && textRows.length < measured.counts.text) {
                    oracleFailures.push(`${name}/${key}: measured ${textRows.length} of ${measured.counts.text} text nodes`);
                }
                if (iconRows && iconRows.length < measured.iconOnly) {
                    oracleFailures.push(`${name}/${key}: measured ${iconRows.length} of ${measured.iconOnly} icon-only controls`);
                }
                if (page.consoleErrors.length) {
                    oracleFailures.push(`${name}/${key}: ${page.consoleErrors.length} console errors`);
                }

                report.surfaces[name][key] = {
                    ...measured, contrastFailures, iconFailures, unmeasurable,
                    consoleErrors: page.consoleErrors.slice(0, 5),
                };
                console.error(
                    `${name}/${key}: contrast ${contrastFailures.length}/${textRows?.length ?? 0}px,`
                    + ` icon ${iconFailures.length}/${iconRows?.length ?? 0}px, unmeasurable ${unmeasurable.length},`
                    + ` target ${measured.targetFailures.length}, unreachable ${measured.unreachable.length},`
                    + ` unnamed ${measured.unnamed.length}, occluded ${measured.occluded.length}`,
                );
            } catch (error) {
                notReached.push(`${name}/${key}: ${String(error?.message ?? error).slice(0, 120)}`);
            } finally {
                await browser.close();
            }
        }
        }
    }
} finally {
    await server.close();
}

const defects = { contrast: 0, icon: 0, unmeasurable: 0, target: 0, unreachable: 0, unnamed: 0, occluded: 0 };
for (const themes of Object.values(report.surfaces)) {
    for (const m of Object.values(themes)) {
        if (!m?.reached) continue;
        defects.contrast += m.contrastFailures.length;
        defects.icon += m.iconFailures.length;
        defects.unmeasurable += m.unmeasurable.length;
        defects.target += m.targetFailures.length;
        defects.unreachable += m.unreachable.length;
        defects.unnamed += m.unnamed.length;
        defects.occluded += m.occluded.length;
    }
}
report.defects = defects;
report.notReached = notReached;
report.oracleFailures = oracleFailures;

if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`wrote ${outPath}`);
}

const total = Object.values(defects).reduce((a, b) => a + b, 0);
if (notReached.length) console.error(`\nFAIL: ${notReached.length} surface/theme pairs unreachable: ${notReached.join(', ')}`);
if (oracleFailures.length) { console.error(`\nFAIL: oracle problems:`); for (const f of oracleFailures) console.error(`  ${f}`); }
if (total) { console.error(`\nFAIL: ${total} visual defects`); for (const [k, n] of Object.entries(defects)) if (n) console.error(`  ${k}: ${n}`); }

if (!reportOnly && (notReached.length || oracleFailures.length || total)) process.exit(1);
