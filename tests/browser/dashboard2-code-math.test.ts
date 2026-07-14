import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => { await Promise.allSettled(browsers.map(browser => browser.close())); await Promise.allSettled(servers.map(server => server.close())); });

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
    const page = await browser.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`http://127.0.0.1:${address.port}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => { const module = await import('/dist/dashboard2/src/dev/render-foundation-harness.tsx'); module.mountRenderFoundationHarness(); });
    await page.waitForFunction(() => Boolean(window.__jawRenderFoundation));
    return page;
}

async function feedAndWaitForHighlight(page: Page, source: string, timeout = 4_000): Promise<number> {
    return page.evaluate(({ text, limit }) => new Promise<number>((resolve, reject) => {
        const started = performance.now();
        const timer = window.setTimeout(() => { observer.disconnect(); reject(new Error(`highlight timeout after ${limit}ms`)); }, limit);
        const observer = new MutationObserver(() => {
            if (document.querySelector('[data-testid="final"] .d2-code-block')?.getAttribute('data-highlight-state') !== 'highlighted') return;
            window.clearTimeout(timer); observer.disconnect(); resolve(performance.now() - started);
        });
        observer.observe(document.querySelector('[data-testid="final"]')!, { attributes: true, childList: true, subtree: true });
        window.__jawRenderFoundation!.feed(text);
    }), { text: source, limit: timeout });
}

function typescriptSource(bytes: number, marker: string): string {
    const lines: string[] = [`const ${marker} = 0;`];
    for (let index = 0; lines.join('\n').length < bytes; index += 1) {
        lines.push(`const value_${marker}_${index}: number = ${index};`);
    }
    return `\`\`\`ts\n${lines.join('\n')}\n\`\`\``;
}

test('R2 browser: code portal reuses one mount and wrap is layout-only', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const source = '```ts\nconst bytes = "original";\n```';
    await page.evaluate(text => window.__jawRenderFoundation!.feed(text), source);
    const block = page.locator('[data-testid="final"] .d2-code-block');
    await block.waitFor();
    assert.equal(await block.count(), 1);
    assert.equal(((await block.locator('code').textContent()) ?? '').trimEnd(), 'const bytes = "original";');
    await page.waitForFunction(() => document.querySelector('[data-testid="final"] .d2-code-block')?.getAttribute('data-highlight-state') !== 'pending');
    const before = await block.locator('code').textContent();
    await block.getByRole('button', { name: /wrap|줄 바꿈/i }).click();
    assert.equal(await block.locator('code').textContent(), before);
    assert.equal(await block.evaluate(element => element.classList.contains('is-wrapped')), true);
    await page.evaluate(text => window.__jawRenderFoundation!.feed(text), source);
    assert.equal(await page.locator('[data-testid="final"] .d2-code-block').count(), 1);
});

test('R2 browser: syntax theme is CSS-only and highlighted HTML has no inline color', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    await page.evaluate(text => window.__jawRenderFoundation!.feed(text), '```ts\nconst answer: number = 42;\n```');
    const block = page.locator('[data-testid="final"] .d2-code-block');
    await block.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="final"] .d2-code-block')?.getAttribute('data-highlight-state') !== 'pending');
    const html = await block.locator('code').innerHTML();
    assert.doesNotMatch(html, /style=|#[0-9a-f]{3,8}|rgb\(/i);
    const requests = await page.evaluate(async () => (await import('/dist/dashboard2/src/turn-stream/render/highlight-service.ts')).getHighlightService().metrics.requests);
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    assert.equal(await page.evaluate(async () => (await import('/dist/dashboard2/src/turn-stream/render/highlight-service.ts')).getHighlightService().metrics.requests), requests);
});

test('R2 browser: KaTeX hydrates only near the viewport and malformed TeX is safe', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const katexRequests: string[] = [];
    const pageErrors: Error[] = [];
    page.on('request', request => { if (/katex/i.test(request.url())) katexRequests.push(request.url()); });
    page.on('pageerror', error => pageErrors.push(error));

    await page.evaluate(() => window.__jawRenderFoundation!.feedMath('c = \\pm\\sqrt{a^2+b^2}', 3_000));
    const slot = page.locator('[data-testid="math-viewport-fixture"] .d2-math-slot');
    await slot.waitFor();
    assert.equal(await slot.getAttribute('data-math-state'), 'pending');
    assert.match((await slot.textContent()) ?? '', /c = \\pm\\sqrt\{a\^2\+b\^2\}/);
    assert.equal(katexRequests.length, 0);

    await slot.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => document.querySelector('[data-testid="math-viewport-fixture"] .d2-math-slot')?.getAttribute('data-math-state') === 'ready');
    assert.equal(await slot.locator('.katex').count(), 1);
    assert.equal(katexRequests.length, 1);

    await page.evaluate(() => window.__jawRenderFoundation!.feedMath('\\frac{', 0));
    const malformed = page.locator('[data-testid="math-viewport-fixture"] .d2-math-slot');
    await malformed.waitFor();
    await malformed.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="math-viewport-fixture"] .d2-math-slot')?.getAttribute('data-math-state');
        return state === 'error' || state === 'pending';
    });
    assert.match((await malformed.textContent()) ?? '', /\\frac\{/);
    assert.deepEqual(pageErrors, []);
});

test('R2 browser: cold and warm highlighting timing smoke', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const coldMs = await feedAndWaitForHighlight(page, typescriptSource(1_024, 'cold'));
    assert.ok(coldMs < 4_000, `cold highlight took ${coldMs.toFixed(1)}ms`);
    t.diagnostic(`cold highlight: ${coldMs.toFixed(1)}ms`);

    const warmMs: number[] = [];
    for (let index = 0; index < 10; index += 1) {
        const elapsed = await feedAndWaitForHighlight(page, `\`\`\`ts\nconst warm_${index}: number = ${index};\n\`\`\``, 500);
        warmMs.push(elapsed);
        assert.ok(elapsed < 500, `warm highlight ${index} took ${elapsed.toFixed(1)}ms`);
    }
    t.diagnostic(`warm highlights: ${warmMs.map(value => value.toFixed(1)).join(', ')}ms`);
});

test('R2 browser: worker highlighting stays responsive and cancels stale render', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    await feedAndWaitForHighlight(page, typescriptSource(9 * 1_024, 'worker_warmup'), 15_000);
    await page.evaluate(() => {
        const target = window as typeof window & { __jawLongTasks?: number[]; __jawLongTaskObserver?: PerformanceObserver };
        target.__jawLongTasks = [];
        target.__jawLongTaskObserver = new PerformanceObserver(list => {
            target.__jawLongTasks!.push(...list.getEntries().map(entry => entry.duration));
        });
        target.__jawLongTaskObserver.observe({ type: 'longtask', buffered: true });
    });
    await feedAndWaitForHighlight(page, typescriptSource(50 * 1_024, 'worker_responsive'), 15_000);
    const longTasks = await page.evaluate(() => {
        const target = window as typeof window & { __jawLongTasks?: number[]; __jawLongTaskObserver?: PerformanceObserver };
        target.__jawLongTaskObserver?.disconnect();
        return target.__jawLongTasks ?? [];
    });
    assert.equal(longTasks.some(duration => duration >= 200), false, `long tasks: ${longTasks.join(', ')}`);

    const sourceA = typescriptSource(50 * 1_024, 'STALE_A_MARKER');
    const sourceB = typescriptSource(50 * 1_024, 'FINAL_B_MARKER');
    await page.evaluate(text => window.__jawRenderFoundation!.feed(text), sourceA);
    await page.waitForFunction(() => document.querySelector('[data-testid="final"] .d2-code-block')?.getAttribute('data-highlight-state') === 'pending');
    await page.evaluate(text => window.__jawRenderFoundation!.feed(text), sourceB);
    await page.waitForFunction(() => document.querySelector('[data-testid="final"] .d2-code-block')?.getAttribute('data-highlight-state') === 'highlighted', undefined, { timeout: 15_000 });
    const rendered = (await page.locator('[data-testid="final"] .d2-code-block code').textContent()) ?? '';
    assert.match(rendered, /FINAL_B_MARKER/);
    assert.doesNotMatch(rendered, /STALE_A_MARKER/);
});

test('R2 browser: cached rerender reuses portals and empty feed cleans them up', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const source = '```ts\nconst first = 1;\n```\n\n```ts\nconst second = 2;\n```\n\n$$x^2 + y^2 = z^2$$';
    await page.evaluate(text => window.__jawRenderFoundation!.feed(text), source);
    const final = page.locator('[data-testid="final"]');
    await final.locator('.d2-code-block').first().waitFor();
    await final.locator('.d2-math-slot').waitFor();
    assert.equal(await final.locator('.d2-code-block').count(), 2);
    assert.equal(await final.locator('.d2-math-slot').count(), 1);

    await page.evaluate(text => window.__jawRenderFoundation!.feed(text), source);
    assert.equal(await final.locator('.d2-code-block').count(), 2);
    assert.equal(await final.locator('.d2-math-slot').count(), 1);

    await page.evaluate(() => window.__jawRenderFoundation!.feed(''));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="final"] .d2-code-block, [data-testid="final"] .d2-math-slot').length === 0);
    assert.equal(await final.locator('.d2-code-block, .d2-math-slot').count(), 0);
});
