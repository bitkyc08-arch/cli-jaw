import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function openHarness(t: TestContext) {
    let browser: Browser | null = null;
    for (const launch of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try { browser = await launch(); break; } catch { /* local fallback */ }
    }
    if (!browser) { t.skip('no local Chrome/Chromium'); return null; }
    browsers.push(browser);
    const { createServer } = await import('vite');
    const server = await createServer({
        configFile: join(ROOT, 'vite.config.ts'),
        root: join(ROOT, 'public'),
        logLevel: 'silent',
        server: { port: 0, host: '127.0.0.1', hmr: false },
    });
    await server.listen();
    servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('vite bind failed');
    const context = await browser.newContext({ viewport: { width: 760, height: 420 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/dev/code-model-session-harness.tsx');
        module.mountCodeModelSessionHarness(target);
    });
    await page.getByRole('combobox', { name: /Active Code session provider and model/ }).waitFor();
    return page;
}

test('dashboard2 Code model session picker renders, switches, and rolls back a failed switch', { timeout: 120_000 }, async t => {
    const page = await openHarness(t);
    if (!page) return;
    const picker = page.getByRole('combobox', { name: /Active Code session provider and model/ });
    assert.match(await picker.getAttribute('aria-label') ?? '', /anthropic.*claude-sonnet-4\.6/);

    await picker.click();
    await page.getByRole('option', { name: /claude-haiku-4\.5/ }).click();
    await page.waitForFunction(() => document.querySelector('main')?.dataset['selected'] === 'anthropic/claude-haiku-4.5');
    assert.equal(await page.locator('main').getAttribute('data-selected'), 'anthropic/claude-haiku-4.5');

    await picker.click();
    await page.getByRole('option', { name: /claude-opus-4\.6/ }).click();
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.equal(await alert.getAttribute('data-error-code'), 'http_error');
    assert.equal(await page.locator('main').getAttribute('data-selected'), 'anthropic/claude-haiku-4.5');
    assert.match(await picker.textContent(), /claude-haiku-4\.5/);

    await picker.focus();
    await picker.press('ArrowDown');
    assert.equal(await picker.getAttribute('aria-expanded'), 'true');
    assert.ok(await picker.getAttribute('aria-activedescendant'));
    await picker.press('Escape');
    assert.equal(await picker.getAttribute('aria-expanded'), 'false');
    assert.ok((await page.screenshot()).byteLength > 1_000);
});
