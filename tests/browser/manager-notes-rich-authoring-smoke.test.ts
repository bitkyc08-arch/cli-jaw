import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const MANAGER_URL = process.env.MANAGER_DASHBOARD_URL || 'http://127.0.0.1:24576/';
const browsers: Browser[] = [];

async function pageForManager(): Promise<Page> {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const context = await browser.newContext();
    return await context.newPage();
}

async function seedRichNote(page: Page, notePath: string): Promise<void> {
    await page.evaluate(async ({ notePath }) => {
        const headers = { 'content-type': 'application/json' };
        await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: notePath, notesViewMode: 'raw', notesAuthoringMode: 'plain' } }),
        });
        await fetch('/api/dashboard/notes/file', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                path: notePath,
                content: [
                    '# Rich smoke',
                    '',
                    '$E = mc^2$',
                    '',
                    '```ts',
                    'const value = 1;',
                    '```',
                ].join('\n'),
            }),
        });
    }, { notePath });
}

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
});

test('notes rich authoring toggles renderer-backed CodeMirror widgets without becoming a view tab', async () => {
    const page = await pageForManager();
    const noteName = `browser-rich-${Date.now()}.md`;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await seedRichNote(page, noteName);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    await page.locator('.notes-tree-file-button').filter({ hasText: noteName }).first().click();
    await page.waitForSelector('.cm-content[contenteditable="true"]');
    assert.equal(await page.getByRole('tab', { name: 'Rich' }).count(), 0, 'Rich must not be a Notes view tab');

    await page.getByRole('button', { name: 'Rich', exact: true }).click();
    await page.waitForSelector('.cm-rich-widget', { timeout: 5000 });
    assert.ok(await page.locator('.cm-rich-widget').count() >= 1, 'Rich authoring must create renderer-backed widgets');

    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.getByRole('tab', { name: 'Raw' }).click();
    await page.waitForSelector('.cm-rich-widget', { timeout: 5000 });
});
