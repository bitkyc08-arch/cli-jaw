import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { cleanupDashboardNotes } from './manager-notes-cleanup';
import { withManagerBrowserLock } from './manager-browser-test-lock';

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

test('notes tree multi-select Delete trashes every selected entry in one keystroke', async () => await withManagerBrowserLock(async () => {
    const page = await pageForManager();
    const runId = `multidel-${Date.now()}`;
    const noteA = `browser-multi-${runId}-a.md`;
    const noteB = `browser-multi-${runId}-b.md`;

    try {
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async () => {
            await fetch('/api/dashboard/registry', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: null } }),
            });
        });
        await seedNote(page, noteA);
        await seedNote(page, noteB);
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
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

        const deadline = Date.now() + 20000;
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
    } finally {
        await cleanupDashboardNotes(page, [
            { path: noteA, kind: 'file' },
            { path: noteB, kind: 'file' },
        ]);
    }
}));

test('notes tree single click clears existing multi-selection', async () => await withManagerBrowserLock(async () => {
    const page = await pageForManager();
    const runId = `multiclear-${Date.now()}`;
    const noteA = `browser-clear-${runId}-a.md`;
    const noteB = `browser-clear-${runId}-b.md`;
    const noteC = `browser-clear-${runId}-c.md`;
    const folderName = `browser-clear-folder-${runId}`;

    try {
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async ({ folderName }) => {
            const headers = { 'content-type': 'application/json' };
            await fetch('/api/dashboard/registry', {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: null } }),
            });
            await fetch('/api/dashboard/notes/folder', {
                method: 'POST',
                headers,
                body: JSON.stringify({ path: folderName }),
            });
        }, { folderName });
        await seedNote(page, noteA);
        await seedNote(page, noteB);
        await seedNote(page, noteC);
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.notes-tree');

        const buttonA = page.locator('.notes-tree-file-button').filter({ hasText: noteA }).first();
        const buttonB = page.locator('.notes-tree-file-button').filter({ hasText: noteB }).first();
        const buttonC = page.locator('.notes-tree-file-button').filter({ hasText: noteC }).first();
        await buttonA.waitFor({ timeout: 5000 });
        await buttonB.waitFor({ timeout: 5000 });
        await buttonC.waitFor({ timeout: 5000 });

        await buttonA.click();
        await page.keyboard.down('Meta');
        await buttonB.click();
        await page.keyboard.up('Meta');
        await page.locator('.notes-tree-selection-info').waitFor({ timeout: 2000 });
        assert.match(await page.locator('.notes-tree-selection-info').innerText(), /2 selected/);

        await buttonC.click();
        await page.waitForSelector('.notes-tree-selection-info', { state: 'detached', timeout: 2000 });
        assert.equal(await page.locator('.notes-tree-file-row.is-multi-selected').count(), 0,
            'plain file click must clear multi-selected file rows');

        await buttonA.click();
        await page.keyboard.down('Meta');
        await buttonB.click();
        await page.keyboard.up('Meta');
        await page.locator('.notes-tree-selection-info').waitFor({ timeout: 2000 });

        await page.locator('.notes-tree-folder-button').filter({ hasText: folderName }).first().click();
        await page.waitForSelector('.notes-tree-selection-info', { state: 'detached', timeout: 2000 });
        assert.equal(await page.locator('.notes-tree-file-row.is-multi-selected, .notes-tree-folder-row.is-multi-selected').count(), 0,
            'plain folder click must clear multi-selected rows');
    } finally {
        await cleanupDashboardNotes(page, [
            { path: noteA, kind: 'file' },
            { path: noteB, kind: 'file' },
            { path: noteC, kind: 'file' },
            { path: folderName, kind: 'folder' },
        ]);
    }
}));

test('notes tree Cmd+Delete trashes the selected folder', async () => await withManagerBrowserLock(async () => {
    const page = await pageForManager();
    const runId = `folder-cmd-delete-${Date.now()}`;
    const folderName = `browser-folder-trash-${runId}`;
    const notePath = `${folderName}/nested.md`;

    try {
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async ({ folderName, notePath }) => {
            const headers = { 'content-type': 'application/json' };
            await fetch('/api/dashboard/registry', {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: null } }),
            });
            await fetch('/api/dashboard/notes/folder', {
                method: 'POST',
                headers,
                body: JSON.stringify({ path: folderName }),
            });
            await fetch('/api/dashboard/notes/file', {
                method: 'POST',
                headers,
                body: JSON.stringify({ path: notePath, content: '# Nested' }),
            });
        }, { folderName, notePath });

        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.notes-tree');

        const folderButton = page.locator('.notes-tree-folder-button').filter({ hasText: folderName }).first();
        await folderButton.waitFor({ timeout: 5000 });
        await folderButton.click();
        await page.locator('.notes-tree-folder-row.is-folder-selected').filter({ hasText: folderName }).waitFor({ timeout: 2000 });
        await page.locator('body').click({ position: { x: 10, y: 10 } });

        const dialogPromise = new Promise<string>((resolve) => {
            page.once('dialog', async (dialog) => {
                const message = dialog.message();
                await dialog.accept();
                resolve(message);
            });
        });

        await page.keyboard.down('Meta');
        await page.keyboard.press('Backspace');
        await page.keyboard.up('Meta');

        const confirmMessage = await Promise.race([
            dialogPromise,
            new Promise<string>((_, reject) => {
                setTimeout(() => reject(new Error('folder trash confirmation dialog did not appear')), 5000);
            }),
        ]);
        assert.match(confirmMessage, /folder/i);
        assert.match(confirmMessage, /trash/i);

        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            const status = await pageApiStatus(page, notePath);
            if (status === 404) break;
            await page.waitForTimeout(150);
        }
        assert.equal(await pageApiStatus(page, notePath), 404, 'Cmd+Delete must trash the selected folder and nested note');
    } finally {
        await cleanupDashboardNotes(page, [
            { path: notePath, kind: 'file' },
            { path: folderName, kind: 'folder' },
        ]);
    }
}));

test('notes tree Cmd+Shift+C copies the selected folder path instead of stale file path', async () => await withManagerBrowserLock(async () => {
    const page = await pageForManager();
    const runId = `folder-copy-${Date.now()}`;
    const folderName = `browser-folder-copy-${runId}`;
    const notePath = `${folderName}/nested.md`;

    try {
        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async ({ folderName, notePath }) => {
            const headers = { 'content-type': 'application/json' };
            await fetch('/api/dashboard/registry', {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: notePath } }),
            });
            await fetch('/api/dashboard/notes/folder', {
                method: 'POST',
                headers,
                body: JSON.stringify({ path: folderName }),
            });
            await fetch('/api/dashboard/notes/file', {
                method: 'POST',
                headers,
                body: JSON.stringify({ path: notePath, content: '# Nested' }),
            });
        }, { folderName, notePath });

        await page.goto(MANAGER_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.notes-tree');
        await page.evaluate(`
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: async function writeText(text) {
                    document.documentElement.dataset.lastCopiedNotesPath = text;
                },
            });
        `);

        const folderButton = page.locator('.notes-tree-folder-button').filter({ hasText: folderName }).first();
        await folderButton.waitFor({ timeout: 5000 });
        await folderButton.click();
        await page.locator('.notes-tree-folder-row.is-folder-selected').filter({ hasText: folderName }).waitFor({ timeout: 2000 });
        await page.locator('body').click({ position: { x: 10, y: 10 } });

        await page.keyboard.down('Meta');
        await page.keyboard.down('Shift');
        await page.keyboard.press('C');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Meta');

        const copied = await page.evaluate(() => document.documentElement.dataset.lastCopiedNotesPath ?? '');
        assert.ok(copied.endsWith(`/${folderName}`),
            'folder copy shortcut must copy the selected folder absolute path');
        assert.equal(copied.endsWith(`/${notePath}`), false,
            'folder copy shortcut must not copy a stale nested file path');
    } finally {
        await cleanupDashboardNotes(page, [
            { path: notePath, kind: 'file' },
            { path: folderName, kind: 'folder' },
        ]);
    }
}));
