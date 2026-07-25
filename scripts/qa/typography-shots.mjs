#!/usr/bin/env node
// wp12 S1 — capture the fixtures DS-7 defines, for human review.
//
// The audit proves every rendered size lands on a scale step. It cannot say
// whether the result looks right, and half-pixel absorption means several
// surfaces did change by a pixel on purpose. Those need eyes.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:24577/dashboard2/';
const OUT = process.argv[3] ?? '/tmp/wp12-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });

for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.d2-shell', { timeout: 15_000 });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: `${OUT}/shell-${theme}.png` });
    console.log(`${OUT}/shell-${theme}.png`);
    await page.close();
}

await browser.close();
