import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { anchorFixtures, diffFixtures, tableFixtures } from '../fixtures/dashboard2/render-parity/r3-embeds-links.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function openHarness(t: TestContext): Promise<Page | null> {
    let browser: Browser | null = null;
    for (const launch of [() => chromium.launch({ headless: true, channel: 'chrome' as const }), () => chromium.launch({ headless: true })]) {
        try { browser = await launch(); break; } catch { /* next local browser */ }
    }
    if (!browser) { t.skip('no local Chrome/Chromium'); return null; }
    browsers.push(browser);
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'public'), logLevel: 'silent', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen(); servers.push({ close: () => server.close() });
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('vite bind failed');
    const origin = `http://127.0.0.1:${address.port}`;
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], baseURL: origin });
    contexts.push(context);
    const page = await context.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        await import('/dist/dashboard2/src/styles/render-content.css');
        const module = await import('/dist/dashboard2/src/dev/render-foundation-harness.tsx');
        module.mountRenderFoundationHarness();
    });
    await page.waitForFunction(() => window.__jawRenderFoundation?.ready() === true);
    return page;
}

const feed = (page: Page, source: string): Promise<void> => page.evaluate(text => window.__jawRenderFoundation!.feed(text), source);

test('R3 browser: tables scroll without shrinking and image placeholders stay inline', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    await feed(page, `${tableFixtures.wide}\n\n${tableFixtures.inlineFlow}`);
    const wrapper = page.locator('[data-testid="final"] .d2-table-wrapper');
    await wrapper.waitFor();
    assert.equal(await wrapper.getAttribute('tabindex'), '0');
    assert.equal(await wrapper.locator('table').count(), 1);
    assert.equal(await page.locator('[data-testid="final"] p > span[data-render-slot] .d2-image-segment').count(), 1);
    await page.setViewportSize({ width: 390, height: 720 });
    assert.equal(await page.locator('[data-testid="final"] .markdown-segment').evaluate(node => getComputedStyle(node).fontSize), '15px');
});

test('R3 browser: unified diff caps mounted rows at 800 plus omission status', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    await feed(page, `\`\`\`diff\n${diffFixtures.rows801}\n\`\`\``);
    const diff = page.locator('[data-testid="final"] .d2-diff');
    await diff.waitFor();
    assert.equal(await diff.locator('.d2-diff__row').count(), 800);
    assert.equal(await diff.locator('.d2-diff__omitted').count(), 1);
    assert.match((await diff.locator('.d2-diff__omitted').textContent()) ?? '', /lines omitted|줄 생략됨/);
});

test('R3 browser: image upload rewrites, decode commits once, and errors hide broken image', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const requested: string[] = [];
    await page.route('**/media/ready.png', route => { requested.push(route.request().url()); return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="currentColor"/></svg>' }); });
    await page.route('**/media/broken.png', route => route.abort());
    await feed(page, '![ready](/uploads/ready.png) ![broken sample](/uploads/broken.png)');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="final"] .d2-image-segment [role="status"]').length === 1);
    assert.equal(requested.length, 1);
    assert.match(requested[0], /\/media\/ready\.png$/);
    const broken = page.locator('[data-testid="final"] .d2-image-segment').filter({ hasText: 'Image unavailable' });
    assert.equal(await broken.locator('img').count(), 0);
    assert.match((await broken.textContent()) ?? '', /broken sample/);
});

test('R3 browser: file paths are keyboard-copy buttons and portal placeholders are untouched', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const path = '/Users/jun/project/src/App.tsx';
    await feed(page, `${path}\n\n\`\`\`ts\nconst nested = "${path}";\n\`\`\``);
    const link = page.locator('[data-testid="final"] [data-file-link]').first();
    await link.waitFor();
    assert.equal(await link.getAttribute('tabindex'), '0');
    await link.focus(); await link.press('Enter');
    await page.waitForFunction(expected => navigator.clipboard.readText().then(value => value === expected), path);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path);
    assert.equal(await page.locator('[data-testid="final"] [data-render-slot] [data-file-link]').count(), 0);
});

test('R3 browser: Mermaid is viewport-gated, sanitized, graceful on error, and anchor-stable', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    await page.route('**/media/anchor.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="20" fill="currentColor"/></svg>' }));
    const spacer = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n\n');
    await feed(page, `<span id="stable-anchor">${anchorFixtures.stableLabel}</span>\n\n${spacer}\n\n${anchorFixtures.mermaid}\n\n${anchorFixtures.image}`);
    const scroll = page.locator('.d2-turn-scroll');
    const mermaid = page.locator('[data-testid="final"] .d2-mermaid');
    await mermaid.waitFor();
    assert.equal(await mermaid.getAttribute('data-state'), 'skeleton');
    await mermaid.scrollIntoViewIfNeeded();
    const stableAnchor = page.locator('[data-testid="final"] #stable-anchor');
    const anchorBefore = await stableAnchor.boundingBox();
    await page.waitForFunction(() => document.querySelector('[data-testid="final"] .d2-mermaid')?.getAttribute('data-state') === 'ready', undefined, { timeout: 30_000 });
    assert.equal(await mermaid.locator('svg').count(), 1);
    assert.doesNotMatch(await mermaid.innerHTML(), /<script|onload=|foreignObject/i);
    const anchorAfter = await stableAnchor.boundingBox();
    if (anchorBefore && anchorAfter) assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) <= 4, `anchor drift ${anchorAfter.y - anchorBefore.y}px`);
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(50);
    const bottomGap = await scroll.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
    assert.ok(bottomGap <= 4, `bottom gap ${bottomGap}px`);

    const firstSvg = await mermaid.innerHTML();
    const nextTheme = await page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches ? 'dark' : 'light');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, nextTheme);
    await page.waitForFunction(previous => document.querySelector('[data-testid="final"] .d2-mermaid')?.innerHTML !== previous, firstSvg, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="final"] .d2-mermaid')?.getAttribute('data-state') === 'ready', undefined, { timeout: 30_000 });
    const themedSvg = await mermaid.innerHTML();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, nextTheme);
    await page.waitForTimeout(100);
    assert.equal(await mermaid.innerHTML(), themedSvg);

    await feed(page, '```mermaid\nthis is not valid mermaid syntax ???\n```');
    await page.locator('[data-testid="final"] .d2-mermaid').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('[data-testid="final"] .d2-mermaid')?.getAttribute('data-state') === 'error', undefined, { timeout: 30_000 });
    assert.equal(await page.locator('[data-testid="final"] .d2-mermaid [role="alert"]').count(), 1);
});
