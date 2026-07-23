import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page, type Route } from 'playwright-core';

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
        } catch { /* try the bundled browser */ }
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

async function injectMountCrash(route: Route): Promise<void> {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'function DesignPanel({ active, payload }) {';
    assert.match(source, new RegExp(marker.replace(/[{}()]/g, '\\$&')), 'Vite DesignPanel transform changed');
    const body = source.replace(marker, `${marker}\n  if (window.__jawWidgetPanelRule4?.consumeCrash()) throw new Error("rule4 mounting crash");`);
    await route.fulfill({ response, body });
}

async function openHarness(t: TestContext): Promise<Page | null> {
    const browser = await launch(t);
    if (!browser) return null;
    const page = await browser.newPage();
    const origin = await startVite();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('**/dashboard2/src/features/panels/DesignPanel.tsx*', injectMountCrash);
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const module = await import('/dist/dashboard2/src/dev/widget-panel-rule4-harness.tsx');
        module.mountWidgetPanelRule4Harness();
    });
    await page.getByTestId('widget-panel-rule4-harness').waitFor();
    await page.locator('[data-testid="rule4-inline-widget"] iframe').waitFor({ state: 'attached' });
    return page;
}

async function expectSettled(page: Page, mode: 'inline' | 'panel'): Promise<void> {
    await page.waitForFunction(expected => {
        const state = window.__jawWidgetPanelRule4?.snapshot();
        return state?.mode === expected && state.handoff === 'idle' && state.request === null;
    }, mode);
}

test('D20 rule 4: widget panel promotion, dedupe, close, crash retry, and crash close reconcile', { timeout: 240_000 }, async t => {
    const page = await openHarness(t);
    if (!page) return;
    const inline = page.getByTestId('rule4-inline-widget');
    const panelAction = inline.getByRole('button', { name: '위젯을 패널로 열기' });

    await panelAction.waitFor();
    await panelAction.click();
    await expectSettled(page, 'panel');
    assert.equal(await inline.locator('iframe').count(), 0, 'panel ownership removes the inline iframe');
    assert.equal(await page.getByRole('tabpanel').locator('iframe').count(), 1, 'panel creates one iframe');
    assert.equal(await page.getByRole('tab', { name: 'Rule 4 widget' }).count(), 1);

    await inline.getByRole('button', { name: '위젯 패널 다시 열기' }).click();
    await expectSettled(page, 'panel');
    assert.equal(await page.getByRole('tab', { name: 'Rule 4 widget' }).count(), 1, 'reopen deduplicates the panel instance');
    assert.equal(await page.getByRole('tabpanel').locator('iframe').count(), 1);

    await page.getByRole('button', { name: 'Close Rule 4 widget' }).click();
    await expectSettled(page, 'inline');
    await inline.locator('iframe').waitFor({ state: 'attached' });

    await page.evaluate(() => window.__jawWidgetPanelRule4!.armCrash());
    await inline.getByRole('button', { name: '위젯을 패널로 열기' }).click();
    await page.getByRole('alert').filter({ hasText: '패널을 표시할 수 없습니다.' }).waitFor();
    assert.equal((await page.evaluate(() => window.__jawWidgetPanelRule4!.snapshot()))?.handoff, 'mounting');
    await page.evaluate(() => window.__jawWidgetPanelRule4!.disarmCrash());
    await page.getByRole('button', { name: '다시 시도' }).click();
    await expectSettled(page, 'panel');
    assert.equal(await page.getByRole('tabpanel').locator('iframe').count(), 1, 'retry remounts DesignPanel successfully');

    await page.getByRole('button', { name: 'Close Rule 4 widget' }).click();
    await expectSettled(page, 'inline');
    await inline.locator('iframe').waitFor({ state: 'attached' });
    await page.evaluate(() => window.__jawWidgetPanelRule4!.armCrash());
    await inline.getByRole('button', { name: '위젯을 패널로 열기' }).click();
    const fallback = page.getByRole('alert').filter({ hasText: '패널을 표시할 수 없습니다.' });
    await fallback.waitFor();
    await fallback.getByRole('button', { name: '패널 닫기' }).click();
    await page.evaluate(() => window.__jawWidgetPanelRule4!.disarmCrash());
    await expectSettled(page, 'inline');
    await inline.locator('iframe').waitFor({ state: 'attached' });
    const state = await page.evaluate(() => window.__jawWidgetPanelRule4!.snapshot());
    assert.equal(state?.handoff, 'idle');
    assert.equal(state?.request, null);
    assert.equal(await page.getByRole('tab', { name: 'Rule 4 widget' }).count(), 0);
});
