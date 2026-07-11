// 044 — browser virtualization gate: REAL TurnStreamViewport/TurnRow tree
// (production components) against the 040 fixture. Skips without a local
// Chrome/Chromium. DOM budget + mounted-row bound + prepend anchor <=4px.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { generateFixture } from '../fixtures/dashboard2/turn-stream/seed.ts';
import { collectHeapUsagePostGc, measurePrependAnchor, sampleDomCountersMedian } from '../helpers/cdp-budget.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const fixture = generateFixture();

const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => {
    await Promise.allSettled(browsers.map(b => b.close()));
    await Promise.allSettled(servers.map(s => s.close()));
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
        } catch { /* next */ }
    }
    t.skip('no local Chrome/Chromium for the virtualization gate');
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

async function mountHarness(page: Page, origin: string): Promise<void> {
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript',
        body: '// virtualization gate stubs app boot',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const mod = await import('/dist/dashboard2/src/dev/turn-virtualization-harness.ts');
        mod.mountTurnVirtualizationHarness();
    });
    const CHUNK = 2000;
    for (let start = 0; start < fixture.lifecycle.length; start += CHUNK) {
        await page.evaluate((events) => {
            window.__jawTurnVirtHarness!.ingestLifecycle(events as never);
        }, fixture.lifecycle.slice(start, start + CHUNK));
    }
    await page.waitForSelector('[data-testid="turn-stream-viewport"]');
    await page.waitForTimeout(200);
}

test('044 browser: mounted rows bounded, DOM budget holds, prepend anchor <=4px', { timeout: 300_000 }, async (t) => {
    const browser = await launchChromium(t);
    if (!browser) return;
    const origin = await startVite();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await mountHarness(page, origin);
    const session = await context.newCDPSession(page);

    // committed rows mounted stay within visible+overscan (overscan 8 both sides)
    const mounted = await page.evaluate(() => window.__jawTurnVirtHarness!.mountedRowCount());
    assert.ok(mounted > 0, 'rows mounted');
    assert.ok(mounted <= 60, `mounted TurnRows ${mounted} <= visible+overscan bound`);

    // 040 DOM budget with the REAL component tree. GC first: the chunked
    // ingest churns detached React nodes that Memory.getDOMCounters still
    // counts until collection (live DOM is ~500 nodes).
    await collectHeapUsagePostGc(session);
    const dom = await sampleDomCountersMedian(session, 3);
    assert.ok(dom.nodes <= 2000, `DOM nodes ${dom.nodes} <= 2000`);

    // prepend anchor: canonical order sorts by turnId, so '0-prepend-*' ids
    // land at the head; compensation must keep the visible row stable.
    // Scroll into the middle first — a top-of-list anchor would get pushed
    // outside the virtual window by the prepends themselves.
    await page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="turn-stream-viewport"]') as HTMLElement;
        scroller.scrollTop = scroller.scrollHeight / 2;
    });
    await page.waitForTimeout(200);
    const anchorTurnId = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-turn-id]')] as HTMLElement[];
        const visible = rows.find(el => el.getBoundingClientRect().top >= 0 && (el.dataset.turnId ?? '') !== '');
        return visible?.dataset.turnId || null;
    });
    assert.ok(anchorTurnId, 'anchor row resolved');
    let prependSeq = 0;
    const anchor = await measurePrependAnchor(page, {
        steps: 200,
        anchorSelector: `[data-turn-id="${anchorTurnId}"]`,
        prepend: async () => {
            prependSeq += 1;
            const turnId = `0-prepend-${String(prependSeq).padStart(4, '0')}`;
            await page.evaluate(({ turnId: id }) => {
                const base = {
                    turnId: id, sessionId: 'fixture-session-0',
                    createdAt: 1_780_000_000_000, observedAt: 1_780_000_000_000, providerAt: null,
                    fidelity: 'full', thinkingMarker: null, detailRef: null,
                };
                window.__jawTurnVirtHarness!.ingestLifecycle([
                    { topic: 'agent', event: 'turn_start', ...base, turnSeq: 1, segmentId: `${id}:start`, type: 'turn_start', status: 'running' },
                    { topic: 'agent', event: 'turn_segment', ...base, turnSeq: 2, segmentId: `${id}:text`, type: 'assistant_text', status: 'done' },
                    { topic: 'agent', event: 'turn_end', ...base, turnSeq: 3, segmentId: `${id}:end`, type: 'turn_end', status: 'done' },
                ] as never);
            }, { turnId });
        },
    });
    assert.ok(anchor.perStepMaxPx <= 4, `prepend per-step drift ${anchor.perStepMaxPx}px <= 4px`);
    assert.ok(anchor.cumulativeDriftPx <= 8, `cumulative drift ${anchor.cumulativeDriftPx}px <= 8px`);
    console.log('[044 virtualization report]', JSON.stringify({ mounted, dom, anchor, parityEvidence: 'synthetic' }));
});
