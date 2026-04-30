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

async function pageApiStatus(page: Page, path: string): Promise<number> {
    return await page.evaluate(async (notePath) => {
        const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(notePath)}`);
        return response.status;
    }, path);
}

async function waitForPageApiStatus(page: Page, path: string, expected: number): Promise<void> {
    const deadline = Date.now() + 5000;
    let latest = await pageApiStatus(page, path);
    while (Date.now() < deadline) {
        if (latest === expected) return;
        await page.waitForTimeout(100);
        latest = await pageApiStatus(page, path);
    }
    assert.equal(latest, expected);
}

async function seedNote(page: Page, notePath: string): Promise<void> {
    await page.evaluate(async ({ notePath }) => {
        const headers = { 'content-type': 'application/json' };
        await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: null } }),
        });
        await fetch('/api/dashboard/notes/file', {
            method: 'POST',
            headers,
            body: JSON.stringify({ path: notePath, content: '# Smoke note' }),
        });
    }, { notePath });
}

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
});

async function pressDeleteAndHandleDialog(
    page: Page,
    noteButton: ReturnType<Page['locator']>,
    action: 'accept' | 'dismiss',
): Promise<string> {
    const dialogPromise = new Promise<string>((resolve) => {
        page.once('dialog', async (dialog) => {
            const message = dialog.message();
            if (action === 'accept') await dialog.accept();
            else await dialog.dismiss();
            resolve(message);
        });
    });
    await noteButton.evaluate((element: Element) => {
        if (element instanceof HTMLElement) element.focus();
    });
    await page.keyboard.press('Delete');
    return await Promise.race([
        dialogPromise,
        new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error('notes trash confirmation dialog did not appear')), 5000);
        }),
    ]);
}

test('notes keyboard trash confirms dirty notes and repairs selection', async () => {
    const page = await pageForManager();
    const runId = `smoke-${Date.now()}`;
    const noteName = `browser-smoke-${runId}-dirty-delete.md`;
    const notePath = noteName;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await seedNote(page, notePath);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    const noteButton = page.locator('.notes-tree-file-button').filter({ hasText: noteName }).first();
    await noteButton.click();
    await page.waitForSelector('.cm-content[contenteditable="true"]');
    await page.locator('.cm-content[contenteditable="true"]').click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('# Dirty local edit');
    await page.waitForSelector('.notes-tree-dirty-dot');

    const cancelMessage = await pressDeleteAndHandleDialog(page, noteButton, 'dismiss');
    assert.match(cancelMessage, /unsaved changes/i);
    assert.equal(await pageApiStatus(page, notePath), 200, 'canceling trash must preserve the dirty note');

    const confirmMessage = await pressDeleteAndHandleDialog(page, noteButton, 'accept');
    assert.match(confirmMessage, /unsaved changes/i);

    await waitForPageApiStatus(page, notePath, 404);
    assert.equal(await pageApiStatus(page, notePath), 404, 'confirming trash must move the note out of the notes tree');
});
