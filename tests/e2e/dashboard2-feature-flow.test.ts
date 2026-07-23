import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [], contexts: BrowserContext[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => {
    await Promise.allSettled(contexts.map(value => value.close()));
    await Promise.allSettled(browsers.map(value => value.close()));
    await Promise.allSettled(servers.map(value => value.close()));
});

async function launchBrowser(): Promise<Browser> {
    for (const launch of [() => chromium.launch({ headless: true, channel: 'chrome' as const }), () => chromium.launch({ headless: true })]) {
        try { const browser = await launch(); browsers.push(browser); return browser; } catch { /* next executable */ }
    }
    throw new Error('dashboard2 feature e2e requires a local Chrome/Chromium executable');
}

async function openHarness(): Promise<Page> {
    const browser = await launchBrowser();
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen(); servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('Vite failed to bind');
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } }); contexts.push(context);
    const page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(window, '__name', { configurable: true, value: (fn: unknown) => fn }); sessionStorage.clear(); });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: 'import { mountE2EAppHarness } from "/dist/dashboard2/src/dev/e2e-app-harness.tsx"; mountE2EAppHarness(document.querySelector("#dashboard2-root"), { historyCount: 100 });' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-view').waitFor();
    return page;
}

async function openPanel(page: Page, type: 'notes' | 'board' | 'reminders'): Promise<void> {
    await page.evaluate(selected => window.__jawE2E.openPanel(selected), type);
    await page.locator(`.d2-side-pane-tab-slot[data-tab="${type}"]`).waitFor();
    await page.getByRole('tab', { name: type[0]!.toUpperCase() + type.slice(1), exact: true }).click();
}

test('Notes, Board, Reminders, and Settings execute through the full production app', { timeout: 240_000 }, async () => {
    const page = await openHarness();

    await openPanel(page, 'notes');
    const noteEditor = page.locator('textarea.d2-notes-textarea');
    const daily = page.locator('[data-notes-path="daily"]');
    if (await daily.getAttribute('aria-expanded') === 'false') await daily.click();
    await page.locator('[data-notes-path="daily/today.md"]').click();
    try { await noteEditor.waitFor({ timeout: 8_000 }); } catch (error) {
        throw new Error(`Notes did not load: ${JSON.stringify(await page.evaluate(() => ({ pane: document.querySelector('.d2-side-pane')?.textContent, requests: window.__jawE2E.api.requests, unknown: window.__jawE2E.api.unknownRequests })))}`, { cause: error });
    }
    await page.keyboard.press('Meta+O');
    await page.getByRole('searchbox', { name: 'Search notes' }).fill('Today');
    await page.getByRole('option', { name: /Today/ }).click();
    await noteEditor.fill('# Today\n\nWP4 edited and saved');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.d2-notes-dirty'));
    assert.equal(await page.evaluate(() => window.__jawE2E.api.note.content), '# Today\n\nWP4 edited and saved');

    await openPanel(page, 'board');
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await noteEditor.fill('# Dirty guard must block');
    await page.evaluate('window.confirm = () => false');
    await page.getByRole('tab', { name: 'Board', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'Notes', exact: true }).getAttribute('aria-selected'), 'true', 'dirty guard cancels navigation');
    await page.evaluate('window.confirm = () => true');
    await page.getByRole('tab', { name: 'Board', exact: true }).click();
    const task = page.locator('[data-board-task-id="task-1"]');
    await task.waitFor();
    await task.press(' '); await task.press('ArrowRight'); await task.press('Enter');
    await page.waitForFunction(() => window.__jawE2E.api.tasks[0]?.lane === 'ready');
    assert.equal(await task.locator('[data-status="todo"]').count(), 1, 'keyboard move lands in Todo');

    await openPanel(page, 'reminders');
    await page.getByRole('button', { name: 'Create reminder' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('WP4 reminder');
    await page.locator('input[type="datetime-local"]').fill('2026-07-25T09:00');
    await page.getByRole('button', { name: 'Add reminder' }).click();
    const complete = page.getByRole('button', { name: 'Complete WP4 reminder' });
    await complete.waitFor(); await complete.click();
    await page.waitForFunction(() => window.__jawE2E.api.reminders[0]?.status === 'done');

    await page.evaluate(() => window.__jawE2E.setSettings());
    await page.getByRole('heading', { name: 'Display' }).waitFor();
    await page.getByRole('combobox', { name: /Theme/ }).selectOption('light');
    await page.getByRole('combobox', { name: /Language/ }).selectOption('ko');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('Display settings saved.').waitFor();
    assert.deepEqual(await page.evaluate(() => ({ theme: window.__jawE2E.api.ui['uiTheme'], locale: window.__jawE2E.api.ui['locale'] })), { theme: 'light', locale: 'ko' });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-view').waitFor();
    await page.evaluate(() => window.__jawE2E.setSettings());
    await page.getByRole('heading', { name: 'Display' }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: /Theme/ }).inputValue(), 'light');
    assert.equal(await page.getByRole('combobox', { name: /Language/ }).inputValue(), 'ko', 'registry values round-trip after reload');
    assert.equal(await page.locator('.d2-side-pane-picker-button[data-tab="settings"]').count(), 0);
});
