import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { xssNegativeFixtures, xssPositiveFixtures } from '../fixtures/dashboard2/render-parity/xss.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => { await Promise.allSettled(browsers.map(b => b.close())); await Promise.allSettled(servers.map(s => s.close())); });

async function launch(t: TestContext): Promise<Browser | null> {
    for (const attempt of [() => chromium.launch({ headless: true, channel: 'chrome' as const }), () => chromium.launch({ headless: true })]) {
        try { const browser = await attempt(); browsers.push(browser); return browser; } catch { /* next */ }
    }
    t.skip('no local Chrome/Chromium'); return null;
}

async function startVite(): Promise<string> {
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen(); servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('vite bind failed');
    return `http://127.0.0.1:${address.port}`;
}

async function openHarness(t: TestContext): Promise<Page | null> {
    const browser = await launch(t); if (!browser) return null;
    const page = await browser.newPage(); const origin = await startVite();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => { const mod = await import('/dist/dashboard2/src/dev/render-foundation-harness.tsx'); mod.mountRenderFoundationHarness(); });
    await page.waitForFunction(() => Boolean(window.__jawRenderFoundation));
    return page;
}

test('R1 browser: user and assistant XSS fixtures are inert', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const sideEffects: string[] = [];
    page.on('dialog', dialog => { sideEffects.push('dialog'); void dialog.dismiss(); });
    page.on('popup', () => sideEffects.push('popup'));
    await page.route(/evil\.test|javascript:|data:text\/html/, route => { sideEffects.push(`network:${route.request().url()}`); void route.abort(); });
    for (const role of ['user', 'assistant'] as const) for (const fixture of xssNegativeFixtures) {
        await page.evaluate(([nextRole, text]) => window.__jawRenderFoundation!.mountXss(nextRole, text), [role, fixture] as const);
        await page.waitForTimeout(10);
        const dangerous = await page.locator('[data-testid="xss-fixture"]').evaluate(root => [...root.querySelectorAll('*')].flatMap(node => [...node.attributes].filter(attr => /^on/i.test(attr.name) || attr.name === 'style' || /^(?:javascript:|data:)/i.test(attr.value)).map(attr => `${node.tagName}:${attr.name}`)));
        assert.deepEqual(dangerous, []);
    }
    await page.evaluate((text) => window.__jawRenderFoundation!.mountXss('assistant', text), xssPositiveFixtures.markdown);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="xss-fixture"] a').length === 3);
    assert.deepEqual(sideEffects, []);
});

test('R1 browser: 20Hz streaming converges to one-shot HTML', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const source = Array.from({ length: 60 }, (_, index) => `## Tick ${index}\n\n- value ${index}\n`).join('');
    const started = Date.now();
    for (let index = 1; index <= 60; index += 1) {
        await page.evaluate((text) => window.__jawRenderFoundation!.feed(text), source.slice(0, Math.ceil(source.length * index / 60)));
        await page.waitForTimeout(50);
    }
    await page.waitForTimeout(150);
    const html = await page.evaluate(() => ({ streaming: document.querySelector('[data-testid="streaming"] .markdown-segment')?.innerHTML, final: document.querySelector('[data-testid="final"] .markdown-segment')?.innerHTML }));
    assert.equal(html.streaming, html.final); assert.ok(Date.now() - started < 10_000);
});

test('R1 browser: locale copy flips without remount', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const tool = page.locator('.d2-tool-line').first(); const widget = page.locator('.d2-widget-segment').first();
    await tool.evaluate(node => node.setAttribute('data-locale-remount-probe', 'stable'));
    await page.evaluate(() => window.__jawRenderFoundation!.setLocale('en'));
    await page.waitForFunction(() => document.querySelector('.d2-segment-status')?.textContent === 'Ran');
    assert.equal(await widget.locator('.d2-widget-state').textContent(), 'Collapsed');
    await page.evaluate(() => window.__jawRenderFoundation!.setLocale('ko'));
    await page.waitForFunction(() => document.querySelector('.d2-segment-status')?.textContent === '실행됨');
    assert.equal(await tool.getAttribute('data-locale-remount-probe'), 'stable');
});
