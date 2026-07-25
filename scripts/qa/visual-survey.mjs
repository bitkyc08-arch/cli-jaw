#!/usr/bin/env node
// wp13 P — measure what a visual gate suite would actually have to assert.
//
// The ask is 100+ visual gates. Writing 100 assertions is easy and worthless;
// the work is finding 100 properties that are (a) currently true or currently
// broken for a real reason, (b) cheap to check, and (c) able to fail when
// someone regresses them. So before writing any gate, survey the live DOM and
// report the raw material: how many distinct values each visual dimension uses,
// and where they disagree with each other.
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:24577/dashboard2/';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.d2-shell', { timeout: 15_000 });
await page.waitForTimeout(2_000);

const survey = await page.evaluate(() => {
    const tally = (values) => {
        const m = new Map();
        for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
        return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
    };

    const visible = [...document.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });

    const controls = visible.filter((el) =>
        /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
        || ['button', 'tab', 'menuitem', 'switch', 'option'].includes(el.getAttribute('role') ?? ''));

    const radii = [];
    const controlHeights = [];
    const gaps = [];
    const paddings = [];
    const shadows = [];
    const durations = [];
    const zIndexes = [];
    const fontWeights = [];

    for (const el of visible) {
        const s = getComputedStyle(el);
        if (s.borderTopLeftRadius !== '0px') radii.push(s.borderTopLeftRadius);
        if (s.boxShadow !== 'none') shadows.push(s.boxShadow.slice(0, 60));
        if (s.transitionDuration !== '0s') durations.push(s.transitionDuration);
        if (s.zIndex !== 'auto') zIndexes.push(s.zIndex);
        if (s.display === 'flex' || s.display === 'grid') { if (s.gap !== 'normal') gaps.push(s.gap); }
        if (el.textContent?.trim()) fontWeights.push(s.fontWeight);
    }

    for (const el of controls) {
        const r = el.getBoundingClientRect();
        controlHeights.push(`${Math.round(r.height)}`);
        const s = getComputedStyle(el);
        paddings.push(`${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`);
    }

    // Controls too small to hit reliably. 24px is the WCAG 2.2 minimum.
    const tooSmall = controls
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.height < 24 || r.width < 24)
        .map(({ el, r }) => ({
            tag: el.tagName,
            cls: String(el.className).slice(0, 44),
            label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 26),
            w: Math.round(r.width),
            h: Math.round(r.height),
        }));

    // Controls with no accessible name at all.
    const unnamed = controls.filter((el) => {
        const name = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '';
        return !name.trim();
    }).map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 44) }));

    return {
        counts: {
            visibleElements: visible.length,
            controls: controls.length,
        },
        radii: tally(radii),
        controlHeights: tally(controlHeights),
        gaps: tally(gaps),
        shadows: tally(shadows),
        durations: tally(durations),
        zIndexes: tally(zIndexes),
        fontWeights: tally(fontWeights),
        controlPaddings: tally(paddings),
        tooSmallCount: tooSmall.length,
        tooSmall: tooSmall.slice(0, 20),
        unnamedCount: unnamed.length,
        unnamed: unnamed.slice(0, 10),
    };
});

console.log(JSON.stringify(survey, null, 2));
await browser.close();
