import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launchChromium(t: TestContext): Promise<Browser | null> {
    for (const attempt of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try {
            const browser = await attempt();
            browsers.push(browser);
            return browser;
        } catch { /* try the next local executable */ }
    }
    t.skip('no local Chrome/Chromium for dashboard2 pending queue');
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

test('047 browser: keyboard arm text and icon controls keep stable geometry', async t => {
    const browser = await launchChromium(t);
    if (!browser) return;
    const origin = await startVite();
    const page = await browser.newPage({ viewport: { width: 420, height: 320 } });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript', body: '// pending queue harness owns this page',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
        const harness = await import('/dist/dashboard2/src/chat/pending/pending-queue-browser-harness.tsx');
        const root = document.createElement('div');
        root.id = 'pending-root';
        document.body.replaceChildren(root);
        harness.mountPendingQueueHarness(root, [{
            id: 'long-item',
            prompt: 'A very long queued prompt that must wrap without moving either action button across the row layout',
            source: 'web',
            ts: 1,
        }]);
    });

    const steer = page.locator('.d2-pending-actions button').nth(0);
    const deletion = page.locator('.d2-pending-actions button').nth(1);
    await steer.waitFor();
    assert.equal(await steer.getAttribute('aria-label'), 'Steer with this message');
    assert.equal(await deletion.getAttribute('aria-label'), 'Delete queued message');
    const before = await Promise.all([steer.boundingBox(), deletion.boundingBox()]);
    await steer.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Steer armed. Activate again to cancel.').waitFor();
    assert.equal(await steer.getAttribute('aria-pressed'), 'true');
    assert.equal(await steer.getAttribute('aria-label'), 'Cancel steer');
    const afterArm = await Promise.all([steer.boundingBox(), deletion.boundingBox()]);
    assert.deepEqual(afterArm, before, 'armed text/icon swap must not shift action geometry');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Steer with this message' }).waitFor();
    const afterCancel = await Promise.all([steer.boundingBox(), deletion.boundingBox()]);
    assert.deepEqual(afterCancel, before, 'cancel must restore the same geometry');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});
