// 048 — rendered history boundary smoke. Uses the production component with
// an injected observer/controller and skips when local Chrome is unavailable.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launch(t: TestContext): Promise<Browser | null> {
    for (const attempt of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try {
            const browser = await attempt();
            browsers.push(browser);
            return browser;
        } catch { /* next */ }
    }
    t.skip('no local Chrome/Chromium');
    return null;
}

async function startVite(): Promise<string> {
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
    return `http://127.0.0.1:${address.port}`;
}

async function mount(page: Page, origin: string): Promise<void> {
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript', body: '// history paging gate stubs app boot',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const mod = await import('/dist/dashboard2/src/turn-stream/history/history-load-boundary-harness.tsx');
        document.body.innerHTML = '<div id="history-test-root"></div>';
        mod.mountHistoryLoadBoundaryHarness(document.querySelector('#history-test-root')!);
    });
    await page.waitForSelector('.d2-history-sentinel', { state: 'attached' });
    await page.waitForFunction(() => window.__jawHistoryPagingHarness?.observerReady() === true);
}

test('048 browser: sentinel loads, retry works, and end state renders', { timeout: 120_000 }, async t => {
    const browser = await launch(t);
    if (!browser) return;
    const origin = await startVite();
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await mount(page, origin);

    await page.evaluate(() => window.__jawHistoryPagingHarness!.intersect());
    await page.waitForSelector('[data-history-state="loading"]');
    assert.match(await page.locator('.d2-history-status').innerText(), /Loading earlier messages/);

    await page.evaluate(() => window.__jawHistoryPagingHarness!.setState({ phase: 'error', error: new Error('500') }));
    await page.getByRole('button', { name: 'Retry history' }).click();
    assert.equal(await page.evaluate(() => window.__jawHistoryPagingHarness!.retryCount()), 1);

    await page.evaluate(() => window.__jawHistoryPagingHarness!.setState({ phase: 'idle', exhausted: true }));
    await page.getByText('Start of history').waitFor();
    console.log('[048 history paging report]', JSON.stringify({ sentinel: true, retry: true, end: true }));
});
