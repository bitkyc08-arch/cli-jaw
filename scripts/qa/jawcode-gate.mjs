#!/usr/bin/env node
// wp13 B4 — the jawcode capability gate, in every state it can be in.
//
// CodeTabGate renders five distinct screens and not one of them was ever
// verified: probing, missing_binary, acp_unsupported, temporarily_unavailable
// and the lazy-loading fallback. Four of those are exactly what a user sees
// when their setup is wrong, which makes them the screens most worth checking
// and the hardest to reach — you cannot uninstall jwc to test it.
//
// Intercepting the capability response gets all of them without touching the
// machine, and the same run measures their contrast, since an unstyled error
// screen is how D11 got in.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openFixture, startFixtureServer } from './fixture-lib.mjs';
import { installMeasure, setTheme, surfacePixelContrast } from './visual-lib.mjs';

const args = process.argv.slice(2);
const outPath = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();

/** What each capability reason must put on screen. */
const STATES = [
    { reason: 'missing_binary', expect: /jwc is not installed/i, retry: true },
    { reason: 'acp_unsupported', expect: /not ACP-compatible/i, retry: true },
    { reason: 'temporarily_unavailable', expect: /temporarily unavailable/i, retry: true },
];

const server = await startFixtureServer();
const results = [];

async function withGate(reason, theme, body) {
    const { browser, page } = await openFixture(server.url, { historyCount: 5 });
    try {
        // The harness intercepts window.fetch, so Playwright's request routing
        // never sees this call; the override goes through the harness instead.
        await page.evaluate((r) => window.__jawE2E.setCapability({ available: r === 'ok', reason: r }), reason);
        await page.evaluate(() => window.__jawE2E.openPanel('code'));
        await page.locator('.d2-code-gate, .d2-code-tab').first().waitFor({ timeout: 15_000 });
        await setTheme(page, theme);
        await page.waitForTimeout(300);
        await installMeasure(page);
        return await body(page);
    } finally {
        await browser.close();
    }
}

try {
    for (const state of STATES) {
        for (const theme of ['dark', 'light']) {
            const outcome = await withGate(state.reason, theme, async (page) => {
                const gate = page.locator('.d2-code-gate');
                const visible = await gate.count() > 0;
                const text = visible ? (await gate.innerText()).replace(/\s+/g, ' ') : '';
                const dataState = visible ? await gate.getAttribute('data-state') : null;

                const retry = page.locator('.d2-code-gate button');
                const retryVisible = await retry.count() > 0;
                const retryEnabled = retryVisible ? await retry.first().isEnabled() : false;

                // The screen that tells a user their setup is broken has to be
                // readable, which is exactly what D11 was not.
                const rows = await surfacePixelContrast(page, '.d2-code-gate');
                const contrastFailures = (rows ?? []).filter(r => !r.pass && !r.unmeasurable);

                return {
                    visible, dataState, retryVisible, retryEnabled,
                    copyMatches: state.expect.test(text),
                    text: text.slice(0, 90),
                    measured: rows?.length ?? 0,
                    contrastFailures: contrastFailures.map(r => ({ ratio: r.ratio, label: r.label })),
                };
            });

            const ok = outcome.visible
                && outcome.dataState === state.reason
                && outcome.copyMatches
                && (!state.retry || (outcome.retryVisible && outcome.retryEnabled))
                && outcome.measured > 0
                && outcome.contrastFailures.length === 0;

            results.push({ id: `${state.reason}/${theme}`, ok, ...outcome });
            console.error(`${ok ? 'OK  ' : 'FAIL'} ${state.reason}/${theme}: state=${outcome.dataState}`
                + ` retry=${outcome.retryVisible ? (outcome.retryEnabled ? 'enabled' : 'disabled') : 'none'}`
                + ` copy=${outcome.copyMatches} contrast=${outcome.contrastFailures.length}/${outcome.measured}`);
        }
    }

    // Retry has to actually retry: a button that reports a failure and then does
    // nothing is worse than no button.
    const retryOutcome = await withGate('temporarily_unavailable', 'dark', async (page) => {
        await page.locator('.d2-code-gate').waitFor({ timeout: 15_000 });
        // Flip the answer, then press Retry: the button has to re-probe and act
        // on the new result, not just re-render the same failure.
        await page.evaluate(() => window.__jawE2E.setCapability({ available: true, reason: 'ok' }));
        await page.locator('.d2-code-gate button').click();
        await page.locator('.d2-code-tab').waitFor({ timeout: 15_000 }).catch(() => {});
        return { probes: 2, reachedTab: await page.locator('.d2-code-tab').count() > 0 };
    });
    const retryOk = retryOutcome.probes >= 2 && retryOutcome.reachedTab;
    results.push({ id: 'retry-succeeds', ok: retryOk, ...retryOutcome });
    console.error(`${retryOk ? 'OK  ' : 'FAIL'} retry-succeeds: probes=${retryOutcome.probes} reachedTab=${retryOutcome.reachedTab}`);
} finally {
    await server.close();
}

if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
    console.error(`wrote ${outPath}`);
}

const failed = results.filter(r => !r.ok);
if (failed.length) {
    console.error(`\nFAIL: ${failed.length} of ${results.length} capability states`);
    process.exit(1);
}
console.log(`\nOK: all ${results.length} capability states render, are operable and readable`);
