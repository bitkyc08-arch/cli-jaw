#!/usr/bin/env node
// wp13 B2 — prove each visual fix was fixing something.
//
// The gate passing today says nothing about whether it would have caught the
// defect yesterday. A check that was green before the fix and green after it is
// not a regression test, it is decoration. M2 requires the opposite proof: run
// the current oracle against the PRE-FIX CSS and watch it fail.
//
// Rather than checking out old commits, each case restores exactly the
// declarations the fix replaced, by injecting them as a stylesheet. That keeps
// the comparison to one variable and makes the reverted rule visible in the
// test rather than buried in git history.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FIXTURE_STATES, FIXTURE_SURFACES, openFixture, startFixtureServer } from './fixture-lib.mjs';
import { chromium } from 'playwright';
import { installMeasure, setTheme, surfaceIconContrast, surfacePixelContrast } from './visual-lib.mjs';

/** The running app, for cases the deterministic fixture cannot express. */
async function openLive(url) {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.consoleErrors = [];
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.d2-shell', { timeout: 15_000 });
    await page.waitForTimeout(2_000);
    const online = page.locator('.d2-instance-main:not([disabled])');
    if (await online.count()) { await online.first().click(); await page.waitForTimeout(2_500); }
    return { browser, page };
}

const args = process.argv.slice(2);
const outPath = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();

/**
 * One case per fixed defect.
 *
 * `revert` is the CSS as it was before the fix. `expect` names which oracle
 * should go red, so a case cannot pass by failing for an unrelated reason.
 */
const CASES = [
    {
        id: 'D2-light-accent',
        defect: 'light --accent on its own soft background measured 4.22:1',
        // The failing pair is an ACTIVE tab: accent text on accent-soft. Settings
        // renders no active segment in the fixture, so the dock is where this
        // defect actually lives.
        surface: 'hover-dock',
        theme: 'light',
        state: 'default',
        expect: 'contrast',
        revert: ':root[data-theme="light"] { --accent: #0969da; --accent-soft: rgba(9, 105, 218, .10); }',
    },
    {
        id: 'D6-board-lane-count',
        defect: 'dark --text-4 on --surface-h measured 4.17:1',
        surface: 'board',
        theme: 'dark',
        state: 'default',
        expect: 'contrast',
        revert: ':root[data-theme="dark"] { --text-4: #82828b; }',
    },
    {
        id: 'D8-notes-header-buttons',
        defect: 'notes header buttons had no styles and sat at 1.01:1 on the UA fill',
        surface: 'notes',
        theme: 'dark',
        state: 'default',
        expect: 'icon',
        // The original pair was the dark-theme icon colour on the LIGHT
        // user-agent button fill, which is what the page rendered before
        // color-scheme was settled -- 1.01:1, an icon the same colour as its own
        // background. Reverting to `all: revert` alone reproduces a dark UA fill
        // instead, so the fill is pinned to the value that was actually on screen.
        revert: '.d2-notes-tree-header-actions button {'
            + ' all: revert; background: rgb(239, 239, 239) !important;'
            + ' color: rgb(240, 240, 242) !important; }',
    },
    {
        id: 'D11-code-gate-unstyled',
        defect: 'the capability gate rendered as a browser-default button at 3.08:1',
        surface: 'code',
        theme: 'light',
        state: 'default',
        expect: 'contrast',
        revert: '.d2-code-gate, .d2-code-gate strong, .d2-code-gate p, .d2-code-gate button {'
            + ' all: revert; } .d2-code-gate { display: block; }',
    },
    {
        id: 'D12-disabled-group-opacity',
        defect: 'disabled controls that paint a background faded the paint with the glyph',
        surface: 'board',
        theme: 'dark',
        state: 'disabled',
        expect: 'unmeasurable',
        revert: '.d2-board-icon-button:disabled { opacity: .4; color: revert; border-color: revert; }',
    },
    {
        id: 'D1-tool-copy-clipped',
        // The e2e harness only produces text turns, so the workbench fixture has
        // no tool lines to clip. This case runs against the LIVE app, where the
        // scan measured 21 unreachable copy buttons before the fix.
        live: 'http://127.0.0.1:24577/dashboard2/',
        defect: '21 tool-copy buttons were pushed onto a clipped second line and could not be clicked',
        surface: 'workbench',
        theme: 'dark',
        state: 'default',
        expect: 'unreachable',
        // Before the fix .d2-tool-line was a block with no layout, so the
        // toggle beside the copy button took the full width and pushed it past
        // the 28px overflow:hidden boundary.
        revert: '.d2-tool-line { display: block; } .d2-tool-copy { opacity: 1; }',
    },
    {
        id: 'D13-terminal-status-on-black',
        defect: 'the terminal panel kept a hard black background for its status messages, reading 1.28:1 in the light theme',
        surface: 'tab-terminal',
        theme: 'light',
        state: 'default',
        expect: 'contrast',
        revert: '.d2-terminal-panel:not(:has(.xterm)) { background: #000; color: var(--text-2); display: block; }',
    },
    {
        id: 'D14-browser-go-group-opacity',
        defect: 'the disabled Go button faded its own background, leaving a pair no rendered check can resolve',
        surface: 'tab-browser',
        theme: 'dark',
        state: 'disabled',
        expect: 'unmeasurable',
        revert: '.d2-browser-url-bar button:disabled { opacity: .45; border-color: revert; color: revert; }',
    },
    {
        id: 'D15-terminal-runtime-children-unstyled',
        // Only reachable once the fixture injects a desktop bridge: without it
        // the panel renders the "requires the Electron app" fallback and the
        // runtime shell never mounts.
        defect: 'the terminal runtime tabs and empty state had no CSS, so they inherited theme text onto the near-black canvas (2.42:1 and 1.21:1 in light)',
        surface: 'tab-terminal',
        theme: 'light',
        state: 'desktop-bridge',
        expect: 'contrast',
        revert: '.d2-terminal-tab, .d2-terminal-new, .d2-terminal-empty {'
            + ' all: revert; color: var(--text-2); }'
            + ' .d2-terminal-empty { display: block; }',
    },
    {
        id: 'D16-browser-agent-toggle-icon-rule',
        defect: 'the agent toggle is the only labelled control in the URL bar, so the 30px icon rule squeezed it and left the label at 4.33:1',
        surface: 'tab-browser',
        theme: 'dark',
        state: 'desktop-bridge',
        expect: 'contrast',
        revert: '.d2-browser-url-bar .d2-browser-agent-toggle {'
            + ' width: 30px; padding: 0; color: var(--text-2); font-size: revert; white-space: revert; }',
    },
];

const server = await startFixtureServer();
const results = [];

async function measure(surface, theme, stateName, revertCss, liveUrl) {
    // A case can opt into the live app when the fixture cannot produce the
    // shape it needs: the harness only renders text turns, so the tool line the
    // copy button lives on never exists there.
    const { browser, page } = liveUrl
        ? await openLive(liveUrl)
        : await openFixture(server.url, {
            historyCount: surface === FIXTURE_SURFACES.workbench ? 40 : 10,
            // Bridge-gated states must be armed before React mounts, exactly as
            // the gate does it; otherwise the case measures the fallback screen.
            ...(FIXTURE_STATES[stateName].needsBridge
                ? { desktopBridge: FIXTURE_STATES[stateName].needsBridge }
                : {}),
        });
    try {
        // Same order as the gate: arm the state, reach the surface, then apply.
        await FIXTURE_STATES[stateName].pre?.(page);
        await surface.reach(page);
        if (revertCss) await page.addStyleTag({ content: revertCss });
        const applied = await FIXTURE_STATES[stateName].apply(page, surface.root);
        if (stateName !== 'default' && applied === 0) return null;
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await installMeasure(page);

        const text = await surfacePixelContrast(page, surface.root);
        await page.waitForTimeout(300);
        const icons = await surfaceIconContrast(page, surface.root, 3);
        const rows = [...(text ?? []), ...(icons ?? [])];

        // Reachability is a DOM question, not a pixel one, so it is measured
        // separately rather than derived from the contrast rows.
        const unreachable = await page.evaluate((sel) => {
            const m = window.__d2measure;
            const scope = document.querySelector(sel);
            if (!scope) return 0;
            let n = 0;
            for (const el of scope.querySelectorAll('button, a, input, select, textarea, [role="button"]')) {
                if (m.unreachableControl(el)) n += 1;
            }
            return n;
        }, surface.root);

        return {
            contrast: (text ?? []).filter((r) => !r.pass && !r.unmeasurable).length,
            icon: (icons ?? []).filter((r) => !r.pass && !r.unmeasurable).length,
            unmeasurable: rows.filter((r) => r.unmeasurable).length,
            unreachable,
            worst: rows.filter((r) => typeof r.ratio === 'number').sort((a, b) => a.ratio - b.ratio)[0] ?? null,
        };
    } finally {
        await browser.close();
    }
}

try {
    for (const testCase of CASES) {
        const surface = FIXTURE_SURFACES[testCase.surface];
        const before = await measure(surface, testCase.theme, testCase.state, testCase.revert, testCase.live);
        const after = await measure(surface, testCase.theme, testCase.state, null, testCase.live);

        const red = Boolean(before && before[testCase.expect] > 0);
        const green = Boolean(after && after[testCase.expect] === 0);
        const ok = red && green;
        results.push({
            id: testCase.id,
            defect: testCase.defect,
            oracle: testCase.expect,
            beforeFix: before,
            afterFix: after,
            failsOnPreFixCode: red,
            passesOnFixedCode: green,
            ok,
        });
        console.error(
            `${ok ? 'OK  ' : 'FAIL'} ${testCase.id}: pre-fix ${testCase.expect}=${before?.[testCase.expect] ?? 'n/a'}`
            + ` (worst ${before?.worst?.ratio ?? '-'}), fixed ${testCase.expect}=${after?.[testCase.expect] ?? 'n/a'}`,
        );
    }
} finally {
    await server.close();
}

const failed = results.filter((r) => !r.ok);
if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
    console.error(`wrote ${outPath}`);
}

if (failed.length) {
    console.error(`\nFAIL: ${failed.length} of ${results.length} cases did not go red on pre-fix code`);
    for (const f of failed) {
        console.error(`  ${f.id}: red=${f.failsOnPreFixCode} green=${f.passesOnFixedCode}`);
    }
    process.exit(1);
}
console.log(`\nOK: all ${results.length} fixes fail on pre-fix code and pass on the current tree`);
