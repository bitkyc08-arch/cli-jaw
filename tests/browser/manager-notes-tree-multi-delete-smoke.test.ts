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

async function seedNote(page: Page, notePath: string): Promise<void> {
    await page.evaluate(async ({ notePath }) => {
        const headers = { 'content-type': 'application/json' };
        await fetch('/api/dashboard/notes/file', {
            method: 'POST',
            headers,
            body: JSON.stringify({ path: notePath, content: `# ${notePath}` }),
        });
    }, { notePath });
}

async function pageApiStatus(page: Page, path: string): Promise<number> {
    return await page.evaluate(async (notePath) => {
        const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(notePath)}`);
        return response.status;
    }, path);
}

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
});

test('notes tree multi-select Delete trashes every selected entry in one keystroke', async () => {
    const page = await pageForManager();
    const runId = `multidel-${Date.now()}`;
    const noteA = `browser-multi-${runId}-a.md`;
    const noteB = `browser-multi-${runId}-b.md`;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
        await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: null } }),
        });
    });
    await seedNote(page, noteA);
    await seedNote(page, noteB);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    const buttonA = page.locator('.notes-tree-file-button').filter({ hasText: noteA }).first();
    const buttonB = page.locator('.notes-tree-file-button').filter({ hasText: noteB }).first();
    await buttonA.waitFor({ timeout: 5000 });
    await buttonB.waitFor({ timeout: 5000 });

    await buttonA.click();
    await page.keyboard.down('Meta');
    await buttonB.click();
    await page.keyboard.up('Meta');

    const info = page.locator('.notes-tree-selection-info');
    await info.waitFor({ timeout: 2000 });
    const infoText = await info.innerText();
    assert.match(infoText, /2 selected/, 'multi-select bar must report 2 selected');

    const dialogPromise = new Promise<string>((resolve) => {
        page.once('dialog', async (dialog) => {
            const message = dialog.message();
            await dialog.accept();
            resolve(message);
        });
    });

    await buttonB.evaluate((el: Element) => {
        if (el instanceof HTMLElement) el.focus();
    });
    await page.keyboard.press('Delete');

    const confirmMessage = await Promise.race([
        dialogPromise,
        new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error('multi-trash confirmation dialog did not appear')), 5000);
        }),
    ]);
    assert.match(confirmMessage, /trash/i);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const a = await pageApiStatus(page, noteA);
        const b = await pageApiStatus(page, noteB);
        if (a === 404 && b === 404) break;
        await page.waitForTimeout(150);
    }
    assert.equal(await pageApiStatus(page, noteA), 404, 'multi-delete must remove note A');
    assert.equal(await pageApiStatus(page, noteB), 404, 'multi-delete must remove note B');

    const tree = await page.evaluate(async () => {
        const response = await fetch('/api/dashboard/notes/tree');
        return await response.json() as Array<{ path: string }>;
    });
    const flatPaths = (function flatten(entries: Array<{ path: string; children?: typeof entries }>): string[] {
        const out: string[] = [];
        for (const entry of entries) {
            out.push(entry.path);
            if (entry.children) out.push(...flatten(entry.children));
        }
        return out;
    })(tree as Array<{ path: string; children?: never }>);
    assert.equal(flatPaths.includes(noteA), false, 'tree response must omit trashed note A');
    assert.equal(flatPaths.includes(noteB), false, 'tree response must omit trashed note B');
});
