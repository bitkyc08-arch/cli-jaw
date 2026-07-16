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
    const context = await browser.newContext({ viewport: { width: 900, height: 520 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('#dashboard2-root')!;
        const module = await import('/dist/dashboard2/src/dev/model-picker-harness.tsx');
        module.mountModelPickerHarness(target);
    });
    await page.getByRole('combobox', { name: /Provider and model/ }).waitFor();
    return page;
}

test('dashboard2 model picker is pointer and keyboard operable', { timeout: 120_000 }, async t => {
    const page = await openHarness(t);
    if (!page) return;
    const trigger = page.getByRole('combobox', { name: /Provider and model/ });
    await trigger.click();
    await page.getByRole('option', { name: /gpt-5\.6-sol/ }).click();
    await page.waitForFunction(() => document.querySelector('main[data-selected]')?.getAttribute('data-selected') === 'codex:gpt-5.6-sol', null, { timeout: 2_000 });
    assert.equal(await page.locator('main[data-selected]').getAttribute('data-selected'), 'codex:gpt-5.6-sol');

    await trigger.focus();
    await trigger.press('ArrowDown');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(await trigger.getAttribute('aria-activedescendant'));
    await trigger.press('End');
    await trigger.press('Enter');
    await page.waitForFunction(() => document.querySelector('main[data-selected]')?.getAttribute('data-selected') === 'codex:gpt-5.6-luna', null, { timeout: 2_000 });
    assert.equal(await page.locator('main[data-selected]').getAttribute('data-selected'), 'codex:gpt-5.6-luna');

    await trigger.press('ArrowDown');
    await trigger.pressSequentially('cla');
    await trigger.press('Enter');
    await page.waitForFunction(() => document.querySelector('main[data-selected]')?.getAttribute('data-selected') === 'claude:claude-sonnet-4.6', null, { timeout: 2_000 });
    assert.equal(await page.locator('main[data-selected]').getAttribute('data-selected'), 'claude:claude-sonnet-4.6');
    await trigger.press('ArrowDown');
    await trigger.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);

    await trigger.press('ArrowDown');
    await trigger.press('Tab');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByTestId('after-picker').evaluate(element => document.activeElement === element), true);
    await page.screenshot({ path: join(ROOT, '.codexclaw/evidence/wp4-model-picker-browser.png') });
});
