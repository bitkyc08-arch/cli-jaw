#!/usr/bin/env node
// wp12 S1 — verify the type scale in a real browser.
//
// jsdom cannot resolve CSS custom properties or compute layout, so a unit test
// can only prove the source contains no literals. It cannot prove the tokens
// resolve, that every rendered size lands on a scale step, or that row heights
// survived. Chrome can.
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:24577/dashboard2/';
const SCALE = [10, 11, 12, 13, 14, 15, 16, 18, 22];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// `networkidle` never fires: dashboard2 holds an SSE connection open for the
// event channel, so the network is idle by design only when it is broken.
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.d2-shell', { timeout: 15_000 });
await page.waitForTimeout(2_000);

const report = await page.evaluate((scale) => {
    const root = getComputedStyle(document.documentElement);
    const tokens = {};
    for (const name of ['2xs', 'xs', 'sm', 'md', 'base', 'prose', 'lg', 'xl', '2xl']) {
        tokens[`--fs-${name}`] = root.getPropertyValue(`--fs-${name}`).trim();
        tokens[`--lh-${name}`] = root.getPropertyValue(`--lh-${name}`).trim();
    }
    tokens['--lh-code-row'] = root.getPropertyValue('--lh-code-row').trim();
    tokens['--lh-composer-row'] = root.getPropertyValue('--lh-composer-row').trim();

    const sizes = new Map();
    const offScale = [];
    for (const el of document.querySelectorAll('*')) {
        if (!el.textContent?.trim()) continue;
        // Visually hidden text has no rendered size to get wrong: the sr-only
        // rule clips it to a 1px box, so its font-size never reaches a screen.
        if (/\bsr-only\b/.test(String(el.className))) continue;
        const style = getComputedStyle(el);
        const px = Math.round(parseFloat(style.fontSize) * 100) / 100;
        sizes.set(px, (sizes.get(px) ?? 0) + 1);
        if (!scale.includes(px)) {
            // Walk up for context: an unstyled element has no class of its own,
            // and the class alone cannot say which one it is.
            const path = [];
            for (let n = el; n && n !== document.body && path.length < 4; n = n.parentElement) {
                path.push(String(n.className || n.tagName).slice(0, 40));
            }
            offScale.push({ px, tag: el.tagName, text: el.textContent.trim().slice(0, 40), path });
        }
    }

    return {
        tokens,
        sizes: Object.fromEntries([...sizes.entries()].sort((a, b) => a[0] - b[0])),
        offScaleCount: offScale.length,
        offScaleSample: offScale.slice(0, 15),
    };
}, SCALE);

console.log(JSON.stringify(report, null, 2));
await browser.close();
