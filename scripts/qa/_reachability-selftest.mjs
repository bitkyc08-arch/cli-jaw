#!/usr/bin/env node
// Behavioural fixtures for unreachableControl.
//
// This check has been wrong in both directions. First it reported nothing,
// because clipped elements were dropped as invisible and the 21 cut-off
// tool-copy buttons disappeared with them. Then it reported a hidden file input
// and a collapsed notes branch as defects. Neither error is visible in a static
// reading of the source, so the exclusions are pinned by behaviour here.
import { chromium } from 'playwright';
import { installMeasure } from './visual-lib.mjs';

const CASES = [
    {
        id: 'clipped-enabled-button',
        expectDefect: true,
        html: '<div style="height:20px;overflow:hidden"><span style="display:block;height:20px">a</span><button id="t">Copy</button></div>',
        why: 'enabled, focusable, cut off by overflow:hidden — the tool-copy case',
    },
    {
        id: 'scrolled-out-button',
        expectDefect: false,
        html: '<div style="height:20px;overflow:auto"><span style="display:block;height:20px">a</span><button id="t">Later</button></div>',
        why: 'the user can scroll to it, so it is reachable',
    },
    {
        id: 'hidden-file-input',
        expectDefect: false,
        html: '<div style="height:0;overflow:hidden"><input id="t" type="file" hidden></div>',
        why: 'the standard way to drive a styled upload button',
    },
    {
        id: 'display-none-branch',
        expectDefect: false,
        html: '<div style="display:none"><div style="height:0;overflow:hidden"><button id="t">Edit</button></div></div>',
        why: 'a collapsed layout branch is a state, not a defect',
    },
    {
        id: 'disabled-clipped-button',
        expectDefect: false,
        html: '<div style="height:0;overflow:hidden"><button id="t" disabled>Nope</button></div>',
        why: 'disabled says the author meant it',
    },
    {
        id: 'aria-hidden-clipped-button',
        expectDefect: false,
        html: '<div aria-hidden="true"><div style="height:0;overflow:hidden"><button id="t">Decorative</button></div></div>',
        why: 'removed from the accessibility tree on purpose',
    },
    {
        id: 'visible-button',
        expectDefect: false,
        html: '<button id="t">Fine</button>',
        why: 'nothing wrong with it',
    },
];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const results = [];
const failures = [];

for (const testCase of CASES) {
    await page.setContent(`<body style="margin:0">${testCase.html}</body>`);
    await installMeasure(page);
    const verdict = await page.evaluate(() => {
        const el = document.getElementById('t');
        return el ? Boolean(window.__d2measure.unreachableControl(el)) : null;
    });
    const ok = verdict === testCase.expectDefect;
    results.push({ id: testCase.id, reported: verdict, expected: testCase.expectDefect, ok, why: testCase.why });
    if (!ok) failures.push(`${testCase.id}: reported ${verdict}, expected ${testCase.expectDefect} (${testCase.why})`);
}

await browser.close();
console.log(JSON.stringify({ results }, null, 2));

if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log('\nOK: reachability reports real defects and excludes deliberate ones');
