#!/usr/bin/env node
// Prove the measurement helpers before trusting anything they report.
//
// This file previously "verified" the contrast helper by comparing it against
// the constant 4.93 that I had typed in after looking at a screenshot once. A
// reviewer pointed out that this proves nothing: the number never came from the
// running page, so the check would keep passing while the page changed
// underneath it. Now every case decodes the real pixels through Chrome.
//
// Three kinds of case:
//   1. synthetic fixtures with an arithmetically known answer
//   2. a known false-positive shape (color(srgb ...) with alpha)
//   3. a known CSSOM blind spot (a pseudo-element gradient backdrop)
import { chromium } from 'playwright';
import { installMeasure, pixelContrast, pixelHistogram, setTheme, surfacePixelContrast } from './visual-lib.mjs';

const TOLERANCE = 0.06;
const failures = [];
const results = [];

function check(name, measured, expected, note) {
    const delta = Math.abs(measured - expected);
    const ok = delta <= TOLERANCE;
    results.push({ name, measured, expected, delta: Number(delta.toFixed(3)), ok, note });
    if (!ok) failures.push(`${name}: measured ${measured}, pixels say ${expected} (delta ${delta.toFixed(3)})`);
}

const browser = await chromium.launch({ channel: 'chrome' });

// ── 1. synthetic fixtures ────────────────────────────────────────────────────
// Built in isolation so the expected value is arithmetic, not observation.
{
    const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
    await page.setContent(`
        <style>
          body { margin: 0; background: #ffffff; }
          .case { width: 200px; height: 60px; display: grid; place-items: center; font: 16px sans-serif; }
          /* black on white: the canonical 21:1 */
          #plain { background: #ffffff; color: #000000; }
          /* an alpha tint expressed the way Chrome serialises color-mix */
          #tinted { background: color-mix(in srgb, #18202a 8%, transparent); color: #586574; }
          /* a gradient painted by a pseudo-element: invisible to backgroundColor */
          #pseudo { position: relative; color: #586574; background: transparent; }
          #pseudo::before { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, #eef1f5 0%, #eef1f5 100%); }
          #pseudo span { position: relative; }
          /* a gradient whose ends differ: the modal colour is light, but part of
             the text sits over a dark band. A "most common backdrop" reading
             passes this; a worst-case reading fails it. */
          #band { background: linear-gradient(90deg, #ffffff 0%, #ffffff 60%, #9aa4b0 60%, #9aa4b0 100%); color: #b9c2cc; }
          /* Two cases a reviewer used to break the previous classifier. Both
             have a mid-grey backdrop, which lies on the RGB line between black
             text and white — exactly what the old antialiasing filter threw
             away, scoring each of them 21:1. */
          #half { background: linear-gradient(90deg,#fff 0%,#fff 60%,#666 60%,#666 100%); color:#000 }
          #thin { background: linear-gradient(90deg,#fff 0%,#fff 47%,#444 47%,#444 53%,#fff 53%,#fff 100%); color:#000 }
        </style>
        <div class="case" id="plain">Sample</div>
        <div class="case" id="tinted">Sample</div>
        <div class="case" id="pseudo"><span>Sample</span></div>
        <div class="case" id="band">Sample text spanning the band</div>
        <div class="case" id="half">Sample text spanning</div>
        <div class="case" id="thin">Sample text spanning</div>
    `);
    await installMeasure(page);

    for (const [id, note] of [
        ['plain', 'black on white'],
        ['tinted', 'alpha tint over white'],
        ['pseudo', 'gradient painted by ::before'],
    ]) {
        const locator = page.locator(`#${id}`);
        const fromPixels = await pixelContrast(page, locator);
        const fromCssom = await page.evaluate((sel) => {
            const m = window.__d2measure;
            const el = document.querySelector(sel);
            return Number(m.contrast(m.parseColour(getComputedStyle(el).color), m.effectiveBackground(el)).toFixed(3));
        }, `#${id}`);
        check(`synthetic/${id}`, fromCssom, fromPixels, note);
    }

    // The parser bug that started all this: srgb floats read as 0-255 integers.
    const parsed = await page.evaluate(() => window.__d2measure.parseColour('color(srgb 0.0941176 0.12549 0.164706 / 0.08)'));
    const expected = { r: 24, g: 32, b: 42 };
    const parseOk = ['r', 'g', 'b'].every((k) => Math.abs(parsed[k] - expected[k]) < 0.5) && Math.abs(parsed.a - 0.08) < 1e-6;
    results.push({ name: 'parser/color(srgb)', measured: parsed, expected, ok: parseOk, note: 'floats must scale to 0-255' });
    if (!parseOk) failures.push(`parser/color(srgb): got ${JSON.stringify(parsed)}`);

    // The worst-case sampler must notice the dark band even though most of the
    // box is white. Without this, a low-contrast region hides behind a majority.
    const bandRows = await surfacePixelContrast(page, '#band');
    const bandRow = bandRows?.find((r) => r.label.startsWith('Sample'));
    const bandOk = bandRow ? bandRow.ratio < 2.2 : false;
    results.push({
        name: 'synthetic/gradient-band',
        measured: bandRow ? bandRow.ratio : null,
        expected: '<2.2 (worst point, not modal colour)',
        ok: bandOk,
        note: 'a dark band under part of the text must not hide behind a white majority',
    });
    if (!bandOk) failures.push(`synthetic/gradient-band: measured ${bandRow?.ratio ?? 'nothing'}`);

    // Regression guards for the reviewer's counterexamples. A mid-grey backdrop
    // must not be excused as antialiasing.
    for (const [id, ceiling, note] of [
        ['half', 4.0, 'black text over a 40% #666 field (true worst ~3.66)'],
        ['thin', 3.0, 'black text over a 6% #444 band (true worst ~2.16)'],
    ]) {
        const rows = await surfacePixelContrast(page, `#${id}`);
        const row = rows?.find((r) => r.label.startsWith('Sample'));
        const ok = row ? row.ratio < ceiling && !row.pass : false;
        results.push({
            name: `counterexample/${id}`,
            measured: row ? row.ratio : null,
            expected: `<${ceiling} and failing`,
            ok,
            note,
        });
        if (!ok) failures.push(`counterexample/${id}: measured ${row?.ratio ?? 'nothing'} (must fail)`);
    }

    await page.close();
}

// ── 2. the live page, where the sidebar paints glass on a pseudo-element ─────
{
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(process.argv[2] ?? 'http://127.0.0.1:24577/dashboard2/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.d2-shell', { timeout: 15_000 });
    await page.waitForTimeout(1_500);

    for (const theme of ['dark', 'light']) {
        await setTheme(page, theme);
        await installMeasure(page);
        const locator = page.locator('.d2-mode-button').nth(1);
        const fromPixels = await pixelContrast(page, locator);
        const fromCssom = await page.evaluate(() => {
            const m = window.__d2measure;
            const el = document.querySelectorAll('.d2-mode-button')[1];
            return Number(m.contrast(m.parseColour(getComputedStyle(el).color), m.effectiveBackground(el)).toFixed(3));
        });
        check(`live/mode-switcher/${theme}`, fromCssom, fromPixels, 'sidebar glass gradient lives on ::before');
    }

    // Histogram sanity: a solid region must be overwhelmingly one colour.
    const shellBox = await page.locator('.d2-workbench').boundingBox();
    if (shellBox) {
        const hist = await pixelHistogram(page, { ...shellBox, height: Math.min(shellBox.height, 200) });
        const share = hist.histogram[0].count / hist.samples;
        results.push({ name: 'histogram/modal-share', measured: Number(share.toFixed(3)), expected: '>0.5', ok: share > 0.5 });
        if (share <= 0.5) failures.push(`histogram/modal-share: modal colour is only ${(share * 100).toFixed(0)}% of the region`);
    }

    await page.close();
}

await browser.close();
console.log(JSON.stringify({ tolerance: TOLERANCE, results }, null, 2));

if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log('\nOK: CSSOM measurement agrees with rendered pixels on every case');
