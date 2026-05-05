import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';

const MANAGER_URL = process.env.MANAGER_DASHBOARD_URL || 'http://127.0.0.1:24576/';
const browsers: Browser[] = [];

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
});

test('notes sidebar does not refetch tree/index on every render while active', async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
        await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                ui: {
                    sidebarMode: 'notes',
                    notesSelectedPath: null,
                    notesViewMode: 'preview',
                    notesAuthoringMode: 'plain',
                },
            }),
        });
    });

    const counts = { tree: 0, index: 0 };
    page.on('request', request => {
        const url = request.url();
        if (url.includes('/api/dashboard/notes/tree')) counts.tree += 1;
        if (url.includes('/api/dashboard/notes/index')) counts.index += 1;
    });

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree', { timeout: 5000 });
    await page.waitForTimeout(2000);

    assert.ok(counts.tree <= 2, `notes tree refetched too often: ${counts.tree}`);
    assert.ok(counts.index <= 2, `notes index refetched too often: ${counts.index}`);
});
