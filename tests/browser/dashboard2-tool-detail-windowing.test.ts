import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page, type Route } from 'playwright-core';
import {
    fixtureLineAtByteOffset,
    generateToolDetail10Mb,
    sliceToolDetailUtf8,
} from '../fixtures/dashboard2/render-parity/tool-detail-10mb.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const detail10Mb = generateToolDetail10Mb();
const detailSmall = 'small clipboard detail\n'.repeat(4_096);
const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(servers.map(server => server.close()));
});

async function launchChromium(t: TestContext): Promise<Browser | null> {
    for (const launch of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try {
            const browser = await launch();
            browsers.push(browser);
            return browser;
        } catch { /* try the bundled browser */ }
    }
    t.skip('no local Chrome/Chromium for the tool-detail browser gate');
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

function envelope(data: unknown): string { return JSON.stringify({ ok: true, data }); }

async function mountRealViewport(page: Page, origin: string): Promise<void> {
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript',
        body: '// tool-detail gate stubs app boot',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const mod = await import('/dist/dashboard2/src/dev/turn-virtualization-harness.ts');
        mod.mountTurnVirtualizationHarness();
        const base = {
            sessionId: 'detail-session', createdAt: 1_790_000_000_000,
            observedAt: 1_790_000_000_000, providerAt: null,
            fidelity: 'full', thinkingMarker: null,
        };
        const events = ['large', 'small', 'missing', 'gone', 'revision'].flatMap((name, index) => {
            const turnId = `detail-${name}`;
            const traceRunId = `run-${name}`;
            return [
                { topic: 'agent', event: 'turn_start', ...base, turnId, turnSeq: 1, segmentId: `${turnId}:start`, type: 'turn_start', status: 'running', detailRef: null },
                { topic: 'agent', event: 'turn_segment', ...base, turnId, turnSeq: 2, segmentId: `${turnId}:tool`, type: 'tool', status: 'done', detailRef: { traceRunId, traceSeq: index + 1 } },
                { topic: 'agent', event: 'turn_end', ...base, turnId, turnSeq: 3, segmentId: `${turnId}:end`, type: 'turn_end', status: 'done', detailRef: null },
            ];
        });
        window.__jawTurnVirtHarness!.ingestLifecycle(events as never);
    });
    await page.waitForSelector('[data-testid="turn-stream-viewport"]');
}

test('084 browser: real row detail stays lazy/windowed and preserves error/copy contracts', { timeout: 300_000 }, async t => {
    const browser = await launchChromium(t);
    if (!browser) return;
    const origin = await startVite();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    const requests: Array<{ runId: string; offset: number | null; limit: number | null }> = [];
    let residentServed = 0;
    let peakResidentServed = 0;

    await page.route('**/api/traces/*/events/*', async (route: Route) => {
        const url = new URL(route.request().url());
        const parts = url.pathname.split('/');
        const runId = parts[parts.indexOf('traces') + 1] ?? '';
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : null;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : null;
        requests.push({ runId, offset, limit });
        if (runId === 'run-missing') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'trace_event_not_found' }) });
        if (runId === 'run-gone') return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'trace_payload_gone' }) });
        if (runId === 'run-revision') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'trace_payload_revision_changed' }) });
        const text = runId === 'run-small' ? detailSmall : detail10Mb;
        const totalBytes = Buffer.byteLength(text, 'utf8');
        if (offset === null) {
            if (runId === 'run-small') return route.fulfill({ status: 200, contentType: 'application/json', body: envelope({ runId, seq: 2, source: 'test', eventType: 'tool', preview: '', bytes: totalBytes, retentionStatus: 'inline', createdAt: 1, raw: text }) });
            return route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'trace_detail_range_required', chunkSize: 262_144, totalBytes, rangeAvailable: true }) });
        }
        assert.ok(limit !== null && limit <= 262_144, `range limit ${limit} <= 262144`);
        const slice = sliceToolDetailUtf8(text, offset, limit ?? 262_144);
        residentServed += slice.actualEndExclusive - slice.actualStart;
        peakResidentServed = Math.max(peakResidentServed, residentServed);
        await route.fulfill({ status: 200, contentType: 'application/json', body: envelope({
            runId, seq: 1, ...slice, requestedLimit: limit, eof: slice.nextOffset === null,
            contentEncoding: 'utf-8',
            line: { first: fixtureLineAtByteOffset(text, slice.actualStart), last: fixtureLineAtByteOffset(text, slice.actualEndExclusive), indexStrideBytes: 65_536 },
            boundary: { utf8Adjusted: slice.utf8Adjusted, startsAtLineBoundary: true, ansiStateBefore: null, ansiStateAfter: null },
            revision: 'fixture-r1',
        }) });
        residentServed -= slice.actualEndExclusive - slice.actualStart;
    });

    await mountRealViewport(page, origin);
    await page.addStyleTag({ content: `
        .d2-tool-detail__viewport{position:relative;height:320px;overflow:auto}
        .d2-tool-detail__spacer{position:relative}
        .d2-tool-detail__line{position:absolute;left:0;height:20px}
    ` });
    assert.equal(await page.locator('[data-tool-detail]').count(), 0, 'collapsed transcript has zero detail DOM');

    const large = page.locator('[data-turn-id="detail-large"]');
    await large.scrollIntoViewIfNeeded();
    await large.locator('.d2-segment-toggle').click();
    await page.waitForSelector('[data-turn-id="detail-large"] [data-tool-detail]');
    await page.waitForSelector('[data-turn-id="detail-large"] .d2-tool-detail__line');
    const lineCount = await large.locator('.d2-tool-detail__line').count();
    assert.ok(lineCount <= 40, `mounted detail lines ${lineCount} <= visible+overscan`);
    assert.ok(requests.every(request => request.limit === null || request.limit <= 262_144));
    assert.ok(peakResidentServed <= 262_144, `mock peak served bytes ${peakResidentServed} <= one chunk`);

    const viewport = large.locator('.d2-tool-detail__viewport');
    const outerAnchorBefore = await large.evaluate(element => element.getBoundingClientRect().top);
    const perf = await viewport.evaluate(async element => {
        const longTasks: number[] = [];
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
        try { observer.observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
        const deltas: number[] = [];
        let previous = performance.now();
        for (let step = 0; step < 30; step += 1) {
            (element as HTMLElement).scrollTop += 120;
            await new Promise<void>(resolve => requestAnimationFrame(now => { deltas.push(now - previous); previous = now; resolve(); }));
        }
        observer.disconnect();
        deltas.sort((a, b) => a - b);
        return { p95: deltas[Math.floor(deltas.length * 0.95)] ?? 0, max: Math.max(...deltas), over100: longTasks.filter(value => value > 100).length };
    });
    const outerAnchorAfter = await large.evaluate(element => element.getBoundingClientRect().top);
    assert.ok(Math.abs(outerAnchorAfter - outerAnchorBefore) <= 4, `outer anchor drift ${Math.abs(outerAnchorAfter - outerAnchorBefore)}px <= 4px`);
    assert.ok(perf.p95 <= 20 && perf.max <= 50 && perf.over100 === 0, `frame budget ${JSON.stringify(perf)}`);

    await large.locator('.d2-segment-toggle').click();
    assert.equal(await large.locator('[data-tool-detail]').count(), 0, 'collapse immediately unmounts detail DOM');
    await large.locator('.d2-segment-toggle').click();
    await page.waitForSelector('[data-turn-id="detail-large"] [data-tool-detail]');

    const small = page.locator('[data-turn-id="detail-small"]');
    await small.locator('.d2-tool-copy').click();
    assert.equal(await small.locator('[data-tool-detail]').count(), 0, 'copy does not mount pane');
    await page.waitForFunction(() => navigator.clipboard.readText().then(text => text.length > 0));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), detailSmall);

    await page.locator('[data-turn-id="detail-missing"] .d2-segment-toggle').click();
    await page.waitForSelector('[data-turn-id="detail-missing"] .is-unavailable');
    await page.locator('[data-turn-id="detail-gone"] .d2-segment-toggle').click();
    await page.waitForSelector('[data-turn-id="detail-gone"] .is-gone');
    await page.locator('[data-turn-id="detail-revision"] .d2-segment-toggle').click();
    await page.waitForSelector('[data-turn-id="detail-revision"] .is-stale-revision');
    console.log('[084 tool detail report]', JSON.stringify({ requests: requests.length, lineCount, peakResidentServed, perf }));
});
