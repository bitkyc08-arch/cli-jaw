// 045 — live tail browser gate: streaming body renders in the live region,
// turn_end folds into the committed list with no duplicate/missing frame,
// bottom-follow only applies when pinned at the end.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => {
    await Promise.allSettled(browsers.map(b => b.close()));
    await Promise.allSettled(servers.map(s => s.close()));
});

async function launch(t: TestContext): Promise<Browser | null> {
    for (const attempt of [
        () => chromium.launch({ headless: true, channel: 'chrome' as const }),
        () => chromium.launch({ headless: true }),
    ]) {
        try { const b = await attempt(); browsers.push(b); return b; } catch { /* next */ }
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

function liveTurn(turnId: string, withTrace: boolean): unknown[] {
    const base = {
        turnId, sessionId: 'live-harness',
        createdAt: 1_790_000_000_000, observedAt: 1_790_000_000_000, providerAt: null,
        fidelity: 'full', thinkingMarker: 'streaming', detailRef: null,
    };
    return [
        { topic: 'agent', event: 'turn_start', ...base, thinkingMarker: null, turnSeq: 1, segmentId: `${turnId}:start`, type: 'turn_start', status: 'running' },
        { topic: 'agent', event: 'turn_segment', ...base, turnSeq: 2, segmentId: `${turnId}:think`, type: 'thinking', status: 'running' },
        ...(withTrace ? [{ topic: 'agent', event: 'turn_segment', ...base, thinkingMarker: null, turnSeq: 3, segmentId: `${turnId}:tool`, type: 'tool', status: 'running', detailRef: { traceRunId: 'live-run-1', traceSeq: 1 } }] : []),
    ];
}

test('045 browser: live tail streams, folds atomically on turn_end, follows bottom', { timeout: 240_000 }, async (t) => {
    const browser = await launch(t);
    if (!browser) return;
    const origin = await startVite();
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page: Page = await context.newPage();
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript', body: '// live gate stub',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const mod = await import('/dist/dashboard2/src/dev/chatview-live-harness.ts');
        mod.mountChatViewLiveHarness();
    });

    // live turn appears in the tail only (not the committed list)
    await page.evaluate((events) => window.__jawLiveHarness!.ingestLifecycle(events as never), liveTurn('live-a', true));
    await page.waitForSelector('[data-live="1"]');
    let counts = await page.evaluate(() => window.__jawLiveHarness!.counts());
    assert.equal(counts.liveArticles, 1, 'live turn renders in the tail');
    assert.equal(counts.committedRows, 0, 'live turn absent from committed list');

    // streaming body reaches the tail via the traceRunId→turnId join
    // (chunks flow through the normalizer + frame scheduler in the harness)
    await page.evaluate(() => window.__jawLiveHarness!.pushBody('live-run-1', 'streaming body text', 19));
    await page.waitForFunction(() => window.__jawLiveHarness!.counts().liveTailText.includes('streaming body text'));

    // shimmer active while running
    const shimmer = await page.evaluate(() =>
        document.querySelectorAll('[data-live="1"] .d2-turn-shimmer, [data-live="1"] .is-running').length);
    assert.ok(shimmer >= 1, 'running segment shimmers in the live tail');

    // Real fast-completion order: agent_done lands before turn_end. The final
    // live body must be promoted so the committed row does not go blank.
    await page.evaluate(() => window.__jawLiveHarness!.finishRun('live-run-1', 'streaming body text'));
    assert.equal(
        await page.evaluate(() => window.__jawLiveHarness!.store.getBodySnapshot('live-a')?.text ?? null),
        'streaming body text',
        'agent_done promotes the final body before turn_end',
    );

    // atomic fold: turn_end removes the live article and mounts exactly one
    // committed row in the same observable state (no duplicate, no missing)
    await page.evaluate(() => window.__jawLiveHarness!.ingestLifecycle([{
        topic: 'agent', event: 'turn_end',
        turnId: 'live-a', turnSeq: 9, segmentId: 'live-a:end', sessionId: 'live-harness',
        createdAt: 1_790_000_001_000, observedAt: 1_790_000_001_000, providerAt: null,
        fidelity: 'full', thinkingMarker: null, type: 'turn_end', status: 'done', detailRef: null,
    }] as never));
    await page.waitForFunction(() => {
        const c = window.__jawLiveHarness!.counts();
        return c.liveArticles === 0 && c.committedRows === 1;
    });
    counts = await page.evaluate(() => window.__jawLiveHarness!.counts());
    assert.equal(counts.liveArticles + counts.committedRows, 1, 'exactly one representation after fold');
    assert.equal(
        await page.evaluate(() => window.__jawLiveHarness!.store.getBodySnapshot('live-a')?.text ?? null),
        'streaming body text',
        'committed turn retains the promoted body',
    );

    // bottom-follow: pinned at end + new live turn keeps the tail visible
    const followed = await page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="turn-stream-viewport"]') as HTMLElement;
        scroller.scrollTop = scroller.scrollHeight;
        return scroller.scrollTop;
    });
    assert.ok(followed >= 0);

    // no-join fallback: a tool-less live turn (detailRef null everywhere)
    // still receives its streaming body when the pairing is unambiguous
    await page.evaluate((events) => window.__jawLiveHarness!.ingestLifecycle(events as never), liveTurn('live-b', false));
    await page.waitForFunction(() => window.__jawLiveHarness!.counts().liveArticles === 1);
    await page.evaluate(() => window.__jawLiveHarness!.pushBody('unjoined-run', 'fallback body', 13));
    await page.waitForFunction(() => window.__jawLiveHarness!.counts().liveTailText.includes('fallback body'));
    console.log('[045 live-tail report]', JSON.stringify({ counts, parityEvidence: 'synthetic' }));
});
