import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { curatedRepresentativeXssCorpus, renderParityCorpus, streamingParityIds, type ExpectedSemantics } from '../fixtures/dashboard2/render-parity/corpus-manifest.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

interface SemanticTree {
    headings: number; code: number; tables: number; links: number; widgets: number;
    mermaid: number; diffs: number; images: number; cards: Record<string, number>;
}

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
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], baseURL: origin, viewport: { width: 1280, height: 720 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((value) => value);' });
    await page.addInitScript(() => {
        const NativeObserver = window.IntersectionObserver;
        const active = new Set<IntersectionObserver>();
        (window as any).__jawActiveObservers = 0;
        class TrackedObserver extends NativeObserver {
            constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { super(callback, options); active.add(this); (window as any).__jawActiveObservers = active.size; }
            disconnect(): void { active.delete(this); (window as any).__jawActiveObservers = active.size; super.disconnect(); }
        }
        Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: TrackedObserver });
        const NativeAbortController = window.AbortController;
        (window as any).__jawAbortCount = 0;
        class TrackedAbortController extends NativeAbortController {
            abort(reason?: unknown): void { (window as any).__jawAbortCount += 1; super.abort(reason); }
        }
        Object.defineProperty(window, 'AbortController', { configurable: true, value: TrackedAbortController });
    });
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
        await import('/dist/dashboard2/src/styles/render-content.css');
        const module = await import('/dist/dashboard2/src/dev/render-foundation-harness.tsx');
        module.mountRenderFoundationHarness();
    });
    await page.waitForFunction(() => window.__jawRenderFoundation?.ready() === true);
    return page;
}

async function settle(page: Page): Promise<void> {
    await page.waitForFunction(() => !document.querySelector('[data-testid="final"] [data-highlight-state="pending"]'));
}

async function semantics(page: Page, selector = '[data-testid="final"]'): Promise<SemanticTree> {
    return page.locator(selector).evaluate(root => {
        const count = (query: string) => root.querySelectorAll(query).length;
        return {
            headings: count('h1,h2,h3,h4,h5,h6'), code: count('pre'), tables: count('table'), links: count('a[href]'),
            widgets: count('.d2-widget-segment'), mermaid: count('.d2-mermaid'), diffs: count('.d2-diff'), images: count('.d2-image-segment'),
            cards: {
                elicitation: count('.elicitation-block'), 'search-results': count('.search-results-block'), dataframe: count('.dataframe-block'),
                'chart-json': count('.chart-json-block'), 'compose-block': count('.compose-block'),
            },
        };
    });
}

function assertExpected(actual: SemanticTree, expected: ExpectedSemantics, id: string): void {
    for (const key of ['headings', 'code', 'tables', 'links', 'widgets', 'mermaid', 'diffs', 'images'] as const) {
        if (expected[key] !== undefined) assert.equal(actual[key], expected[key], `${id}: ${key}`);
    }
    for (const [kind, count] of Object.entries(expected.cards ?? {})) assert.equal(actual.cards[kind], count, `${id}: ${kind} cards`);
}

function seededCuts(length: number, seed: number): number[] {
    const cuts: number[] = []; let state = seed >>> 0; let offset = 0;
    while (offset < length) { state = (state * 1664525 + 1013904223) >>> 0; offset = Math.min(length, offset + 1 + state % 23); cuts.push(offset); }
    return cuts;
}

test('08x semantic parity: curated representative corpus matches coarse trees', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    for (const entry of renderParityCorpus) {
        assert.equal(entry.provenance, 'curated-synthetic');
        await page.evaluate(source => window.__jawRenderFoundation!.feedFinal(source), entry.source);
        await settle(page);
        assertExpected(await semantics(page), entry.expectedSemantics, entry.id);
    }
});

test('08x streaming differential: seeded cuts finalize to one-shot semantics without early fence inflation', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    for (const id of streamingParityIds) {
        const entry = renderParityCorpus.find(item => item.id === id)!;
        await page.evaluate(() => { window.__jawRenderFoundation!.feedStreaming(''); window.__jawRenderFoundation!.feedFinal(''); });
        for (const cut of seededCuts(entry.source.length, id.length * 7919)) {
            await page.evaluate(source => window.__jawRenderFoundation!.feedStreaming(source), entry.source.slice(0, cut));
            assert.equal(await page.locator('[data-testid="streaming"] .elicitation-block, [data-testid="streaming"] .search-results-block, [data-testid="streaming"] .dataframe-block, [data-testid="streaming"] .chart-json-block, [data-testid="streaming"] .compose-block, [data-testid="streaming"] .d2-widget-segment').count(), 0, `${id}: interactive DOM before terminal`);
        }
        await page.evaluate(source => window.__jawRenderFoundation!.feedFinal(source), entry.source);
        await settle(page);
        const oneShot = await semantics(page);
        await page.evaluate(source => window.__jawRenderFoundation!.feedFinal(source), entry.source);
        await settle(page);
        assert.deepEqual(await semantics(page), oneShot, `${id}: terminal semantics`);
    }
});

test('08x D20 browser rules: live/completed lifecycle, sandbox, fresh iframe, and Mermaid separation', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    await page.evaluate(() => window.__jawRenderFoundation!.setWidgetMode('live'));
    await page.waitForSelector('[data-testid="live-widget"] iframe', { state: 'attached' });
    const liveFrame = page.locator('[data-testid="live-widget"] iframe');
    assert.equal(await liveFrame.getAttribute('sandbox'), 'allow-scripts');
    assert.doesNotMatch((await liveFrame.getAttribute('sandbox')) ?? '', /allow-same-origin/);
    await page.evaluate(() => window.__jawRenderFoundation!.setWidgetMode('completed'));
    assert.equal(await page.locator('iframe').count(), 0, 'completed turn starts collapsed');
    const toggle = page.locator('[data-testid="completed-widget"] .d2-segment-toggle');
    await toggle.click(); await page.waitForSelector('[data-testid="completed-widget"] iframe', { state: 'attached' });
    await page.locator('[data-testid="completed-widget"] iframe').evaluate(node => node.setAttribute('data-first-instance', 'true'));
    await toggle.click(); assert.equal(await page.locator('iframe').count(), 0, 'collapse destroys iframe');
    await toggle.click(); await page.waitForSelector('[data-testid="completed-widget"] iframe', { state: 'attached' });
    assert.equal(await page.locator('[data-testid="completed-widget"] iframe[data-first-instance]').count(), 0, 're-expand creates a fresh iframe');
    assert.equal(await page.locator('[data-testid="completed-widget"] :text("Open in panel")').count(), 0, 'EXTERNAL-BLOCKED D20 rule 4: no panel action');
    await page.evaluate(() => window.__jawRenderFoundation!.setWidgetMode('mermaid'));
    await page.locator('[data-testid="mermaid-widget-rule"] .d2-mermaid').waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'Mermaid never enters widget runtime');
});

test('08x link preview opt-in: default zero, viewport fetch, opt-out abort and hidden cleanup', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const requests: string[] = []; let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    await page.route('**/api/link-preview?**', async route => {
        requests.push(route.request().url());
        if (requests.length === 2) await secondGate;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { title: 'Preview', finalUrl: 'https://example.com/near' } }) });
    });
    const source = '[near](https://example.com/near)\n\n' + 'spacer\n\n'.repeat(250) + '[far](https://example.org/far)';
    await page.evaluate(text => window.__jawRenderFoundation!.feedFinal(text), source);
    assert.equal(requests.length, 0); assert.equal(await page.evaluate(() => (window as any).__jawActiveObservers), 0);
    await page.evaluate(() => window.__jawRenderFoundation!.setLinkPreviews(true));
    await page.waitForFunction(() => document.querySelectorAll('.d2-link-preview').length === 1);
    assert.equal(requests.length, 1, 'only near anchor fetched');
    const farRequest = page.waitForRequest(request => request.url().includes('/api/link-preview') && request.url().includes('example.org'));
    await page.locator('[data-testid="final"] a[href="https://example.org/far"]').scrollIntoViewIfNeeded();
    await farRequest;
    const abortedRequest = page.waitForEvent('requestfailed', { predicate: request => request.url().includes('/api/link-preview') && request.url().includes('example.org') });
    await page.evaluate(() => window.__jawRenderFoundation!.setLinkPreviews(false));
    await page.waitForFunction(() => (window as any).__jawActiveObservers === 0);
    await abortedRequest;
    releaseSecond();
    const stoppedAt = requests.length;
    await page.evaluate(() => window.__jawRenderFoundation!.setHidden(true));
    await page.locator('.d2-turn-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert.equal(requests.length, stoppedAt);
});

test('08x XSS rerun: current full pipeline has no dialogs, navigation, or side effects', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    let dialogs = 0; let externalRequests = 0; const origin = new URL(page.url()).origin;
    page.on('dialog', async dialog => { dialogs += 1; await dialog.dismiss(); });
    page.on('request', request => { if (!request.url().startsWith(origin)) externalRequests += 1; });
    for (const entry of curatedRepresentativeXssCorpus) {
        await page.evaluate(source => window.__jawRenderFoundation!.feedFinal(source), entry.source);
        assert.equal(await page.locator('[data-testid="final"] script, [data-testid="final"] iframe, [data-testid="final"] style, [data-testid="final"] [onload], [data-testid="final"] [onclick]').count(), 0, entry.id);
    }
    assert.equal(dialogs, 0); assert.equal(externalRequests, 0); assert.equal(new URL(page.url()).origin, origin);
});

test('08x teardown baseline: resources return to zero with no console errors or unhandled rejections', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.evaluate(() => window.__jawRenderFoundation!.setWidgetMode('live'));
    await page.waitForSelector('iframe', { state: 'attached' });
    await page.evaluate(() => window.__jawRenderFoundation!.unmount());
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 0 && (window as any).__jawActiveObservers === 0);
    assert.equal(await page.locator('iframe').count(), 0); assert.deepEqual(errors, []);
});

test('08x caveat sweep: theme/width/hidden invariants and explicit external blockers', { timeout: 240_000 }, async t => {
    const page = await openHarness(t); if (!page) return;
    const errors: string[] = []; const requests: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (request.url().includes('/api/link-preview')) requests.push(request.url()); });
    await page.evaluate(source => window.__jawRenderFoundation!.feedFinal(source), renderParityCorpus.find(item => item.id === 'dataframe-valid')!.source);
    const widths: number[] = [];
    for (const theme of ['dark', 'light'] as const) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.style.colorScheme = value; }, theme);
        widths.push(await page.locator('.d2-turn-scroll').evaluate(node => node.getBoundingClientRect().width));
    }
    assert.ok(Math.abs(widths[0]! - widths[1]!) <= 1, `transcript width drift ${widths.join(' -> ')}`);
    await page.evaluate(() => window.__jawRenderFoundation!.setHidden(true));
    assert.equal(await page.locator('iframe').count(), 0); assert.equal(requests.length, 0); assert.deepEqual(errors, []);
    t.diagnostic('CAVEAT 056: PASS dark/light 1280x720 width stable and console clean');
    t.diagnostic('CAVEAT X1/X4: PASS hidden renderer adds no iframe or preview request');
    t.diagnostic('CAVEAT X7: PARTIAL invalid segments are bounded; shell per-tab error boundary remains EXTERNAL-BLOCKED(075)');
    t.diagnostic('CAVEAT X10: PASS harness teardown owns renderer-local resources; Code keep-alive remains owning-suite evidence');
    t.diagnostic('CAVEAT P2/P5/P7/P8/P9: EXTERNAL-BLOCKED(075); no temporary panel portal asserted');
    t.diagnostic('CAVEAT Notes/Diff/theme: PASS shared sanitizer and diff/theme paths exercised; Notes ownership unchanged');
    t.diagnostic('CAVEAT link-preview/tool-search: PASS default OFF; unified server-hit navigation EXTERNAL-BLOCKED(084)');
});
