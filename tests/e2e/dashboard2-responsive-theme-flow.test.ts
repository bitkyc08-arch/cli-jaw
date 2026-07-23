import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [], contexts: BrowserContext[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => {
    await Promise.allSettled(contexts.map(value => value.close()));
    await Promise.allSettled(browsers.map(value => value.close()));
    await Promise.allSettled(servers.map(value => value.close()));
});

async function browserOrFail(): Promise<Browser> {
    for (const launch of [() => chromium.launch({ headless: true, channel: 'chrome' as const }), () => chromium.launch({ headless: true })]) {
        try { const browser = await launch(); browsers.push(browser); return browser; } catch { /* try bundled */ }
    }
    throw new Error('dashboard2 responsive/theme e2e requires local Chrome/Chromium');
}

test('dark/light at every supported 720px+ width preserves the selected session and production tree identity', { timeout: 180_000 }, async () => {
    const browser = await browserOrFail();
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen(); servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('Vite failed to bind');
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
    const page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(window, '__name', { configurable: true, value: (fn: unknown) => fn }); localStorage.clear(); sessionStorage.clear(); });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: 'import { mountE2EAppHarness } from "/dist/dashboard2/src/dev/e2e-app-harness.tsx"; mountE2EAppHarness(document.querySelector("#dashboard2-root"), { historyCount: 1000 });' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-view').waitFor();
    await page.locator('.d2-turn-slot').first().waitFor();
    await page.evaluate(() => { window.__jawE2E.openPanel('notes'); (window as typeof window & { __responsiveChat?: Element }).__responsiveChat = document.querySelector('[data-testid="chat-view"]')!; });
    await page.locator('.d2-side-pane-tab-slot[data-tab="notes"]').waitFor();

    for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(() => window.__jawE2E.setSettings());
        await page.getByRole('heading', { name: 'Display' }).waitFor();
        await page.getByRole('combobox', { name: /Theme/ }).selectOption(theme);
        await page.getByRole('button', { name: 'Save changes' }).click();
        await page.getByText('Display settings saved.').waitFor();
        await page.getByRole('button', { name: 'Back to chat' }).click();
        await page.getByTestId('chat-view').waitFor({ state: 'visible' });

        for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 720, height: 900 }]) {
            await page.setViewportSize(viewport);
            await page.waitForFunction(expected => document.querySelector('.d2-shell')?.classList.contains('d2-sb-closed') === expected, viewport.width < 1024);
            const state = await page.evaluate(() => ({
                theme: document.documentElement.dataset['theme'],
                selected: window.__jawE2E.diagnostics().selected,
                pane: window.__jawE2E.diagnostics().panels.some(panel => panel.type === 'notes'),
                sameChat: (window as typeof window & { __responsiveChat?: Element }).__responsiveChat === document.querySelector('[data-testid="chat-view"]'),
                overflow: Math.max(document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth),
            }));
            assert.deepEqual(state, { theme, selected: '3506/wp4-e2e-session', pane: true, sameChat: true, overflow: 0 }, `${theme} ${viewport.width}x${viewport.height}`);
        }
    }
});
