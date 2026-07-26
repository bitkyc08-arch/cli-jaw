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
import { installMeasure, pixelContrast, pixelHistogram, setTheme, surfaceIconContrast, surfacePixelContrast } from './visual-lib.mjs';

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
    const page = await browser.newPage({ viewport: { width: 400, height: 1400 } });
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
          /* Text and icon almost the same colour as their background. This is
             the worst possible outcome and the easiest to lose: hiding the
             foreground barely moves the pixels, so a generous difference
             threshold produced no row at all — and no row reads as a pass. */
          #near { background:#787878; color:#777 }
          /* A scrollport narrower than its content. The reviewer's
             counterexample: text at 1.02:1 that a user plainly sees at the
             left edge, on a line far wider than the captured panel. The
             element rect falls outside the clip, so an oracle that skips or
             excuses those pixels passes a defect it can see. */
          #scrollport { width: 220px; overflow-x: auto; background:#787878; }
          #scrollport > span { display: inline-block; width: 1200px; color:#777; font: 16px sans-serif; }
          #nearicon { background:#787878; color:#777 }
          /* Translucent foregrounds. The computed colour is pure black in every
             one of these, so reading the computed colour and ignoring alpha
             scored them 21:1 while they render at about 1.25:1. */
          #op { color:#000; opacity:.1 }
          #alphafg { color:rgba(0,0,0,.1) }
          #ancop { opacity:.1 }
          /* Gradient text clipped to the glyphs. dashboard2 ships this on
             .d2-turn-shimmer: the computed colour is transparent, so a naive
             reading scores a perfectly legible label at 1:1. The oracle must
             say it cannot judge rather than invent either verdict. */
          #grad { background:linear-gradient(100deg,#ddd 30%,#eee 50%,#ddd 70%); background-clip:text; -webkit-background-clip:text; color:transparent }
          /* Group opacity: the browser renders the element AND its background,
             then fades both. Sampling the faded backdrop while using the unfaded
             glyph colour computed 21:1 for a pair that renders near 3.95:1. */
          #group { background:#fff; color:#000; opacity:.5 }
          /* A 1%-wide real dark stripe. Any share-based exemption drops it. */
          #stripe { background:linear-gradient(90deg,#fff 0%,#fff 49.5%,#444 49.5%,#444 50.5%,#fff 50.5%,#fff 100%); color:#000 }
          /* -webkit-text-fill-color wins over color; reading color scored 21:1. */
          #fill { background:#fff; color:#000; -webkit-text-fill-color:#777 }
          /* An opacity wrapper that paints nothing itself, with a child that
             does. The first fail-closed rule only checked the faded node's own
             background and let this through as a 2.63:1 failure where it
             renders 5.32:1 -- a false alarm rather than a miss, but wrong. */
          #wrapop { opacity:.5 }
          #wrapop .inner { background:#fff; color:#000 }
          /* An icon crossing a 2%-wide dark stripe: the share exemption the text
             path dropped survived in the icon path for one round. */
          #istripe { background:linear-gradient(90deg,#fff 0%,#fff 49%,#444 49%,#444 51%,#fff 51%,#fff 100%) }
        </style>
        <div class="case" id="plain">Sample</div>
        <div class="case" id="tinted">Sample</div>
        <div class="case" id="pseudo"><span>Sample</span></div>
        <div class="case" id="band">Sample text spanning the band</div>
        <div class="case" id="half">Sample text spanning</div>
        <div class="case" id="thin">Sample text spanning</div>
        <div class="case" id="near">Nearly invisible text</div>
        <div id="scrollport"><span>Wide overflowing low contrast text that runs past the panel</span></div>
        <div class="case" id="nearicon"><button aria-label="Close" style="background:transparent;border:0;color:#777"><svg width="16" height="16"><path d="M2 2 L14 14" stroke="currentColor" stroke-width="2"/></svg></button></div>
        <div class="case" id="op">Element opacity</div>
        <div class="case" id="alphafg">Alpha foreground</div>
        <div id="ancop"><div class="case">Ancestor opacity</div></div>
        <div class="case" id="grad">Shimmering label</div>
        <div class="case" id="group">Group opacity text</div>
        <div class="case" id="stripe">Stripe under text spanning wide</div>
        <div class="case" id="fill">Text fill override</div>
        <div id="wrapop"><div class="case"><span class="inner">Child paints inside wrapper</span></div></div>
        <div class="case" id="istripe"><button aria-label="Close" style="background:transparent;border:0;color:#000"><svg width="120" height="20"><path d="M0 10 L120 10" stroke="currentColor" stroke-width="3"/></svg></button></div>
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

    // Near-equal foreground and background must produce a FAILING row, not a
    // missing one. The distinction matters: an element with no row is invisible
    // to the gate, so the worst defect would be the one it never reports.
    const nearRows = await surfacePixelContrast(page, '#near');
    const nearRow = nearRows?.find((r) => r.label.startsWith('Nearly'));
    const nearOk = Boolean(nearRow) && nearRow.ratio < 1.2 && !nearRow.pass;
    results.push({
        name: 'counterexample/near-equal-text',
        measured: nearRow ? nearRow.ratio : 'NO ROW',
        expected: '~1.0 and failing',
        ok: nearOk,
        note: 'text the same colour as its background must not vanish from the report',
    });
    if (!nearOk) failures.push(`counterexample/near-equal-text: ${nearRow ? nearRow.ratio : 'produced no row'}`);

    // Content wider than its own scrollport must still be measured on the part
    // a user can see. Reporting it as unmeasurable is a fail-open: the row
    // exists, carries no ratio, and the gate counts nothing.
    const wideRows = await surfacePixelContrast(page, '#scrollport');
    const wideRow = wideRows?.find((r) => (r.label ?? '').startsWith('Wide overflowing'));
    const wideOk = Boolean(wideRow) && typeof wideRow.ratio === 'number'
        && wideRow.ratio < 1.5 && !wideRow.pass && !wideRow.offCapture;
    results.push({
        name: 'counterexample/overflow-visible-intersection',
        measured: wideRow ? (wideRow.offCapture ? 'offCapture' : wideRow.ratio) : 'NO ROW',
        expected: '~1.0 and failing',
        ok: wideOk,
        note: 'visible pixels of an element wider than the capture must be measured, not excused',
    });
    if (!wideOk) {
        failures.push(`counterexample/overflow-visible-intersection: ${
            wideRow ? (wideRow.offCapture ? 'excused as offCapture' : wideRow.ratio) : 'produced no row'}`);
    }

    const nearIconRows = await surfaceIconContrast(page, '#nearicon');
    const nearIcon = nearIconRows?.[0];
    const nearIconOk = Boolean(nearIcon) && nearIcon.ratio < 1.2 && !nearIcon.pass;
    results.push({
        name: 'counterexample/near-equal-icon',
        measured: nearIcon ? nearIcon.ratio : 'NO ROW',
        expected: '~1.0 and failing',
        ok: nearIconOk,
        note: 'an icon the same colour as its background must not vanish either',
    });
    if (!nearIconOk) failures.push(`counterexample/near-equal-icon: ${nearIcon ? nearIcon.ratio : 'produced no row'}`);

    // Alpha and inherited opacity must land in the contrast maths. Each of these
    // computes to solid black, and each renders as pale grey.
    // `op` and `ancop` became unmeasurable when group opacity started failing
    // closed, and `null < 1.6` is true in JavaScript, so they kept passing for
    // the wrong reason. Assert what each one actually promises now.
    for (const [id, label, expectation] of [
        ['op', 'Element opacity', 'group-opacity'],
        ['alphafg', 'Alpha foreground', 'ratio'],
        ['ancop', 'Ancestor opacity', 'group-opacity'],
    ]) {
        const rows = await surfacePixelContrast(page, `#${id}`);
        const row = rows?.find((r) => r.label.startsWith(label.split(' ')[0]));
        const ok = expectation === 'group-opacity'
            ? Boolean(row) && String(row.unmeasurable ?? '').startsWith('group-opacity') && !row.pass
            : Boolean(row) && typeof row.ratio === 'number' && row.ratio < 1.6 && !row.pass;
        results.push({
            name: `counterexample/${id}`,
            measured: row ? row.ratio : 'NO ROW',
            expected: expectation === 'group-opacity' ? 'unmeasurable, fail-closed' : '<1.6 and failing',
            ok,
            note: `${label}: computed colour is solid black, rendered is pale grey`,
        });
        if (!ok) failures.push(`counterexample/${id}: ${row ? row.ratio : 'produced no row'}`);
    }

    // A foreground the CSSOM cannot describe must be reported as unmeasurable,
    // not guessed. Guessing a pass hides defects; guessing a fail sends someone
    // to "fix" working code.
    const gradRows = await surfacePixelContrast(page, '#grad');
    const gradRow = gradRows?.[0];
    const gradOk = Boolean(gradRow) && gradRow.unmeasurable === 'background-clip:text' && gradRow.ratio === null && !gradRow.pass;
    results.push({
        name: 'counterexample/gradient-text',
        measured: gradRow ? (gradRow.unmeasurable ?? gradRow.ratio) : 'NO ROW',
        expected: 'unmeasurable, fail-closed',
        ok: gradOk,
        note: 'background-clip:text means the computed colour is not the glyph colour',
    });
    if (!gradOk) failures.push(`counterexample/gradient-text: ${JSON.stringify(gradRow ?? null)}`);

    // Group opacity cannot be resolved from a paired capture: it needs the
    // colour behind the whole group. Say so rather than compute the wrong pair.
    const groupRows = await surfacePixelContrast(page, '#group');
    const groupRow = groupRows?.[0];
    const groupOk = Boolean(groupRow) && String(groupRow.unmeasurable ?? '').startsWith('group-opacity') && !groupRow.pass;
    results.push({
        name: 'counterexample/group-opacity',
        measured: groupRow ? (groupRow.unmeasurable ?? groupRow.ratio) : 'NO ROW',
        expected: 'unmeasurable, fail-closed',
        ok: groupOk,
        note: 'opacity on a painted group fades glyph and backdrop together',
    });
    if (!groupOk) failures.push(`counterexample/group-opacity: ${JSON.stringify(groupRow ?? null)}`);

    for (const [id, ceiling, note] of [
        ['stripe', 2.6, 'a 1%-wide real dark stripe is still a real backdrop'],
        ['fill', 4.5, '-webkit-text-fill-color is the painted colour, not `color`'],
    ]) {
        const rows = await surfacePixelContrast(page, `#${id}`);
        const row = rows?.[0];
        const ok = Boolean(row) && row.ratio !== null && row.ratio < ceiling && !row.pass;
        results.push({
            name: `counterexample/${id}`,
            measured: row ? row.ratio : 'NO ROW',
            expected: `<${ceiling} and failing`,
            ok,
            note,
        });
        if (!ok) failures.push(`counterexample/${id}: ${row ? row.ratio : 'produced no row'}`);
    }

    // Any group opacity is unmeasurable, whoever inside it does the painting.
    const wrapRows = await surfacePixelContrast(page, '#wrapop');
    const wrapRow = wrapRows?.[0];
    const wrapOk = Boolean(wrapRow) && String(wrapRow.unmeasurable ?? '').startsWith('group-opacity');
    results.push({
        name: 'counterexample/wrapper-opacity',
        measured: wrapRow ? (wrapRow.unmeasurable ?? wrapRow.ratio) : 'NO ROW',
        expected: 'unmeasurable, fail-closed',
        ok: wrapOk,
        note: 'a child, image or pseudo-element inside the group paints too',
    });
    if (!wrapOk) failures.push(`counterexample/wrapper-opacity: ${JSON.stringify(wrapRow ?? null)}`);

    // The icon path must not keep an exemption the text path already dropped.
    const iconStripeRows = await surfaceIconContrast(page, '#istripe');
    const iconStripe = iconStripeRows?.[0];
    const iconStripeOk = Boolean(iconStripe) && iconStripe.ratio !== null && iconStripe.ratio < 2.6 && !iconStripe.pass;
    results.push({
        name: 'counterexample/icon-stripe',
        measured: iconStripe ? iconStripe.ratio : 'NO ROW',
        expected: '<2.6 and failing',
        ok: iconStripeOk,
        note: 'a 2%-wide dark stripe under an icon stroke is a real backdrop',
    });
    if (!iconStripeOk) failures.push(`counterexample/icon-stripe: ${iconStripe ? iconStripe.ratio : 'produced no row'}`);

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
