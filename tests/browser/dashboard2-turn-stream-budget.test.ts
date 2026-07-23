// 040.2 — turn-stream fixture hash + CDP budget gate.
// Part 1 (always runs, node-only): fixture determinism, §3 distribution
// contract, manifest match, arrival-variant convergence, prod-bundle guard.
// Part 2 (browser; skips when no local Chrome/Chromium): DOM/heap/frame/anchor
// budgets + v4 shell assertions against the dev fixture surface.
// Parity evidence stays SYNTHETIC (034 §1.5) — real 3-runtime replay is 048.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
    FIXTURE_SEED, TURN_COUNT, MESSAGE_COUNT,
    canonicalSegmentHash, computeStats, duplicateVariant, fixtureHash,
    generateFixture, isGrokPairTurn, isOpenTurn, isPromotionTurn,
    partialOverlapVariant, reorderVariant, replayGapVariant, segmentFromLifecycle,
} from '../fixtures/dashboard2/turn-stream/seed.ts';
import {
    collectHeapUsagePostGc, measureFrameDeltas, measurePrependAnchor, sampleDomCountersMedian,
} from '../helpers/cdp-budget.ts';
import type { FixtureHandle } from '../../public/dashboard2/src/dev/turn-stream-fixture.ts';

declare global {
    interface Window { __jawTurnStreamFixture?: FixtureHandle }
}

const ROOT = resolve(import.meta.dirname, '..', '..');
const MANIFEST_PATH = join(ROOT, 'tests/fixtures/dashboard2/turn-stream/manifest.json');
const FRAME_BUDGET_MS = Number(process.env.JAW_FRAME_BUDGET_MS || 60_000);
const SOAK_ENABLED = process.env.JAW_DASHBOARD2_SOAK === '1';
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES || 3);
const SOAK_TIME_SCALE = Number(process.env.SOAK_TIME_SCALE || (SOAK_MINUTES >= 60 ? 1 : 0.1));
const SOAK_STREAM_ENABLED = process.env.JAW_SOAK_STREAM !== '0';
const SOAK_PREPEND_ENABLED = process.env.JAW_SOAK_PREPEND !== '0';
const SOAK_TAB_CYCLE_ENABLED = process.env.JAW_SOAK_TAB_CYCLE !== '0';
const EVIDENCE_PATH = join(ROOT, 'refs/091-baseline-full-budget.json');

const SEGMENT_KEYS = [
    'turnId', 'turnSeq', 'segmentId', 'sessionId', 'createdAt', 'observedAt',
    'providerAt', 'fidelity', 'thinkingMarker', 'type', 'status', 'detailRef',
].sort();

const fixture = generateFixture();
const stats = computeStats(fixture);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

// ─── Part 1: fixture contract (node-only) ───────────────────────────

test('040 fixture: same seed twice is byte-identical and matches manifest', () => {
    const again = generateFixture(FIXTURE_SEED);
    assert.equal(fixtureHash(fixture), fixtureHash(again));
    assert.equal(canonicalSegmentHash(fixture.segments), canonicalSegmentHash(again.segments));
    assert.equal(fixtureHash(fixture), manifest.fixtureHash);
    assert.equal(canonicalSegmentHash(fixture.segments), manifest.canonicalSegmentHash);
    assert.deepEqual(stats, manifest.distributions);
    assert.equal(manifest.parityEvidence, 'synthetic');
});

test('040 fixture: §3 distribution contract', () => {
    assert.equal(stats.turnCount, TURN_COUNT);
    assert.equal(stats.messageCount, MESSAGE_COUNT);
    for (const status of ['done', 'error', 'continued', 'interrupted'] as const) {
        assert.ok(stats.statusTurns[status] >= 100, `status ${status} >= 100 turns`);
    }
    for (const fidelity of ['full', 'coarse', 'text_only'] as const) {
        assert.ok(stats.fidelityTurns[fidelity] >= 1000, `fidelity ${fidelity} >= 1000 turns`);
    }
    for (const marker of ['streaming', 'plaintext', 'encrypted', 'token_fallback', 'pre_tool_text', 'plan', 'planner']) {
        assert.ok((stats.markerRows[marker] ?? 0) >= 100, `marker ${marker} >= 100 rows`);
    }
    assert.ok(stats.promotionTurns >= 100, 'coarse→full promotion >= 100 turns');
    assert.ok(stats.grokPairTurns >= 100, 'grok pair >= 100 turns');
    assert.ok(stats.openTurns >= 100, 'running (shimmer) turns >= 100');
});

test('040 fixture: grok pair is exactly 2 durable rows with distinct turnSeq', () => {
    const bySegment = new Map<string, { turnSeq: number; status: string }[]>();
    for (const row of fixture.segments) {
        if (row.type !== 'thinking') continue;
        const rows = bySegment.get(row.segmentId) ?? [];
        rows.push({ turnSeq: row.turnSeq, status: row.status });
        bySegment.set(row.segmentId, rows);
    }
    let checked = 0;
    for (let i = 0; i < TURN_COUNT; i++) {
        if (!isGrokPairTurn(i)) continue;
        const rows = bySegment.get(`fixture-turn-${String(i).padStart(5, '0')}:think`) ?? [];
        assert.equal(rows.length, 2, `grok turn ${i} has exactly 2 durable rows`);
        assert.notEqual(rows[0].turnSeq, rows[1].turnSeq);
        assert.deepEqual(rows.map(r => r.status), ['running', 'done']);
        checked += 1;
    }
    assert.ok(checked >= 100);
});

test('040 fixture: D21 segments are body-less metadata; message DTO owns bodies', () => {
    for (const row of fixture.segments.slice(0, 500)) {
        assert.deepEqual(Object.keys(row).sort(), SEGMENT_KEYS);
    }
    const assistant = fixture.messages.find(m => m.role === 'assistant');
    assert.ok(assistant);
    assert.equal(typeof assistant.id, 'number');
    assert.ok(assistant.content.length > 0);
    assert.ok(Array.isArray(assistant.turn_segments));
});

test('040 fixture: duplicate/reorder/replay-gap/overlap variants converge to canonical hash', () => {
    const base = canonicalSegmentHash(fixture.segments);
    for (const variant of [duplicateVariant, reorderVariant, replayGapVariant, partialOverlapVariant]) {
        const rows = variant(fixture.lifecycle).map(segmentFromLifecycle);
        assert.equal(canonicalSegmentHash(rows), base, `${variant.name} converges`);
    }
});

test('040 guard: fixture module is absent from any built production bundle', () => {
    const distDir = join(ROOT, 'public/dist');
    if (!existsSync(distDir)) return; // build-output guard is conditional on a built tree
    const offenders: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(js|css|html)$/.test(entry.name)) {
                const text = readFileSync(full, 'utf8');
                if (text.includes('jawTurnStreamFixture') || text.includes('d2fix-shell')) offenders.push(full);
            }
        }
    };
    walk(distDir);
    assert.deepEqual(offenders, []);
});

// ─── Part 2: browser budget gate ────────────────────────────────────

const browsers: Browser[] = [];
const servers: { close(): Promise<void> }[] = [];
after(async () => {
    const bounded = (operation: Promise<unknown>) => Promise.race([
        operation.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    await Promise.all(browsers.map(async (browser) => {
        const context = browser.contexts()[0];
        const page = context?.pages()[0];
        if (context && page) {
            const session = await context.newCDPSession(page).catch(() => null);
            if (session) await bounded(session.send('Browser.close'));
        }
        await bounded(browser.close());
    }));
    await Promise.all(servers.map((server) => bounded(server.close())));
    if (SOAK_ENABLED) {
        setTimeout(() => process.exit(process.exitCode ?? 0), 1_000);
    }
});

async function launchChromium(t: TestContext): Promise<Browser | null> {
    const attempts: (() => Promise<Browser>)[] = [];
    if (process.env.JAW_BUDGET_CHROME) {
        attempts.push(() => chromium.launch({ headless: true, executablePath: process.env.JAW_BUDGET_CHROME }));
    }
    attempts.push(() => chromium.launch({ headless: true, channel: 'chrome' }));
    attempts.push(() => chromium.launch({ headless: true }));
    for (const attempt of attempts) {
        try {
            const browser = await attempt();
            browsers.push(browser);
            return browser;
        } catch { /* try next */ }
    }
    t.skip('no local Chrome/Chromium executable for the CDP budget gate');
    return null;
}

async function startVite(): Promise<{ origin: string }> {
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
    if (!address || typeof address !== 'object') throw new Error('vite dev server failed to bind');
    return { origin: `http://127.0.0.1:${address.port}` };
}

async function mountFixtureSurface(page: Page, origin: string): Promise<void> {
    await page.route('**/dashboard2/src/main.tsx*', route => route.fulfill({
        contentType: 'application/javascript',
        body: '// 040 budget harness stubs app boot; only the fixture surface mounts',
    }));
    await page.goto(`${origin}/dist/dashboard2/index.html`, { waitUntil: 'domcontentloaded' });
    // tsx/esbuild keepNames injects __name() into evaluate callbacks; shim it in-page.
    await page.evaluate('window.__name = window.__name || ((fn) => fn)');
    await page.evaluate(async () => {
        const mod = await import('/dist/dashboard2/src/dev/turn-stream-fixture.ts');
        (window as unknown as Record<string, unknown>).__fixtureModule = mod;
        (window as unknown as Record<string, unknown>).__fixtureRows = [];
    });
    const CHUNK = 500;
    for (let start = 0; start < fixture.messages.length; start += CHUNK) {
        await page.evaluate((batch) => {
            ((window as unknown as Record<string, unknown>).__fixtureRows as unknown[]).push(...batch);
        }, fixture.messages.slice(start, start + CHUNK));
    }
    await page.evaluate(async () => {
        const w = window as unknown as Record<string, any>;
        await w.__fixtureModule.mountTurnStreamFixture(w.__fixtureRows);
    });
    await page.waitForSelector('[data-testid="fixture-transcript"]');
}

test('040 budget: DOM/heap/frame/anchor budgets + v4 shell assertions (synthetic surface)', { timeout: FRAME_BUDGET_MS + 240_000 }, async (t) => {
    const browser = await launchChromium(t);
    if (!browser) return;
    const { origin } = await startVite();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await mountFixtureSurface(page, origin);
    const session = await context.newCDPSession(page);
    const report: Record<string, unknown> = { parityEvidence: 'synthetic' };

    // v4 shell: transcript stays <=700px in the left column, side pane open+closed.
    const shellMetrics = async () => page.evaluate(() => {
        const transcript = document.querySelector('[data-testid="fixture-transcript"]')!.getBoundingClientRect();
        const side = document.querySelector('[data-testid="fixture-side-pane"]')!.getBoundingClientRect();
        return { transcriptWidth: transcript.width, transcriptRight: transcript.right, sideWidth: side.width, sideLeft: side.left };
    });
    const openMetrics = await shellMetrics();
    assert.ok(openMetrics.transcriptWidth <= 700, `transcript ${openMetrics.transcriptWidth}px <= 700px (pane open)`);
    assert.ok(openMetrics.sideWidth >= 340, 'side pane >= 340px when open');
    assert.ok(openMetrics.transcriptRight <= openMetrics.sideLeft, 'transcript stays left of the side pane');
    await page.evaluate(() => window.__jawTurnStreamFixture!.setSidePane(false));
    const closedMetrics = await shellMetrics();
    assert.ok(closedMetrics.transcriptWidth <= 700, `transcript ${closedMetrics.transcriptWidth}px <= 700px (pane closed)`);
    assert.ok(closedMetrics.sideWidth < 1, 'side pane collapses when closed');
    await page.evaluate(() => window.__jawTurnStreamFixture!.setSidePane(true));
    report.shell = { openMetrics, closedMetrics };

    // Shimmer: running segments animate; terminal transition removes the animation.
    await page.evaluate(() => window.__jawTurnStreamFixture!.scrollToIndex(99));
    await page.waitForSelector('[data-shimmer="1"]');
    const animation = await page.evaluate(() =>
        getComputedStyle(document.querySelector('[data-shimmer="1"]')!).animationName);
    assert.equal(animation, 'd2fix-shimmer');
    await page.evaluate(() => window.__jawTurnStreamFixture!.completeOpenTurns());
    await page.waitForFunction(() => document.querySelectorAll('[data-shimmer="1"]').length === 0);
    report.shimmer = { animation, clearedAfterTerminal: true };

    // DOM budget: settle then 3-sample median <= 2000 nodes.
    await page.evaluate(() => window.__jawTurnStreamFixture!.scrollToIndex(5000));
    await page.waitForTimeout(250);
    const dom = await sampleDomCountersMedian(session, 3);
    assert.ok(dom.nodes <= 2000, `DOM nodes ${dom.nodes} <= 2000`);
    report.dom = dom;

    // Heap baseline after load (post-GC).
    const heapBefore = await collectHeapUsagePostGc(session);
    const countersBefore = await sampleDomCountersMedian(session, 1);

    // Live frame budget: 20Hz streaming appends, p95 <= 50ms, max <= 100ms.
    let streamId = 500_000;
    const frames = await measureFrameDeltas(page, {
        hz: 20,
        durationMs: FRAME_BUDGET_MS,
        onTick: async () => {
            streamId += 1;
            await page.evaluate((id) => window.__jawTurnStreamFixture!.append({
                id,
                role: 'assistant',
                content: `stream row ${id}`,
                cli: 'codex', model: 'model-0', tool_log: null, trace_run_id: null,
                turn_id: `stream-turn-${id}`, cost_usd: null, duration_ms: 42,
                working_dir: '/tmp/jaw-fixture',
                created_at: new Date(0).toISOString(),
                turn_segments: [],
            }), streamId);
        },
    });
    assert.ok(frames.p95Ms <= 50, `frame p95 ${frames.p95Ms}ms <= 50ms`);
    assert.ok(frames.maxMs <= 100, `frame max ${frames.maxMs}ms <= 100ms`);
    report.frames = frames;

    // Prepend anchor: 200 prepends, each <=4px, cumulative drift <=8px.
    await page.evaluate(() => window.__jawTurnStreamFixture!.scrollToIndex(500));
    await page.waitForTimeout(120);
    const anchorTurnId = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.d2fix-row[data-turn-id]')] as HTMLElement[];
        const visible = rows.find(el => el.getBoundingClientRect().top >= 0 && (el.dataset.turnId ?? '') !== '');
        return visible?.dataset.turnId || null;
    });
    assert.ok(anchorTurnId, 'anchor row resolved');
    let prependId = 900_000;
    const anchor = await measurePrependAnchor(page, {
        steps: 200,
        anchorSelector: `.d2fix-row[data-turn-id="${anchorTurnId}"]`,
        prepend: async () => {
            prependId += 1;
            await page.evaluate((id) => window.__jawTurnStreamFixture!.prepend([{
                id,
                role: 'assistant',
                content: `prepended row ${id}`,
                cli: 'codex', model: 'model-0', tool_log: null, trace_run_id: null,
                turn_id: `prepend-turn-${id}`, cost_usd: null, duration_ms: 42,
                working_dir: '/tmp/jaw-fixture',
                created_at: new Date(0).toISOString(),
                turn_segments: [],
            }]), prependId);
        },
    });
    assert.ok(anchor.perStepMaxPx <= 4, `prepend per-step drift ${anchor.perStepMaxPx}px <= 4px`);
    assert.ok(anchor.cumulativeDriftPx <= 8, `prepend cumulative drift ${anchor.cumulativeDriftPx}px <= 8px`);
    report.anchor = anchor;

    // Heap growth after activity (post-GC): <= max(16MiB, 10% of baseline).
    const heapAfter = await collectHeapUsagePostGc(session);
    const growth = heapAfter.usedSizeBytes - heapBefore.usedSizeBytes;
    const heapCap = Math.max(16 * 1024 * 1024, heapBefore.usedSizeBytes * 0.1);
    assert.ok(growth <= heapCap, `heap growth ${growth}B <= ${Math.round(heapCap)}B`);
    const countersAfter = await sampleDomCountersMedian(session, 1);
    report.heap = { before: heapBefore, after: heapAfter, growth, cap: Math.round(heapCap) };
    // Gate B resource stability: listener/document counts stay near baseline
    report.resources = {
        before: countersBefore,
        after: countersAfter,
        listenerDelta: countersAfter.jsEventListeners - countersBefore.jsEventListeners,
        documentDelta: countersAfter.documents - countersBefore.documents,
    };
    assert.ok(Math.abs(countersAfter.documents - countersBefore.documents) <= 1, 'document count stable');

    console.log('[040 budget report]', JSON.stringify(report));
});

function regressionSlopeBytesPerHour(samples: Array<{ elapsedMs: number; heapBytes: number }>, windowMinutes: number, timeScale: number): number {
    const cutoff = samples.at(-1)!.elapsedMs - windowMinutes * 60_000;
    const rows = samples.filter((sample) => sample.elapsedMs >= cutoff);
    assert.ok(rows.length >= 7, `slope requires 7+ samples, received ${rows.length}`);
    const xs = rows.map((sample) => sample.elapsedMs / timeScale / 3_600_000);
    const ys = rows.map((sample) => sample.heapBytes);
    const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
    return denominator === 0 ? 0 : xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index] - yMean), 0) / denominator;
}

if (SOAK_ENABLED) test('091 Chrome soak: 20Hz + prepend/tab cycles + five-minute post-GC time series', { timeout: SOAK_MINUTES * 60_000 + 240_000 }, async (t) => {
    assert.ok(Number.isFinite(SOAK_MINUTES) && SOAK_MINUTES > 0, 'SOAK_MINUTES must be positive');
    assert.ok(Number.isFinite(SOAK_TIME_SCALE) && SOAK_TIME_SCALE > 0, 'SOAK_TIME_SCALE must be positive');
    const browser = await launchChromium(t);
    if (!browser) return;
    const { origin } = await startVite();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await mountFixtureSurface(page, origin);
    const session = await context.newCDPSession(page);
    const durationMs = SOAK_MINUTES * 60_000;
    const sampleIntervalMs = 5 * 60_000 * SOAK_TIME_SCALE;
    const prependIntervalMs = 5 * 60_000 * SOAK_TIME_SCALE;
    const tabIntervalMs = 2 * 60_000 * SOAK_TIME_SCALE;
    const slopeWindowMinutes = 30 * SOAK_TIME_SCALE;
    const startedAt = performance.now();
    let nextSampleAt = 0;
    let nextPrependAt = prependIntervalMs;
    let nextTabAt = tabIntervalMs;
    let streamId = 1_000_000;
    let prependId = 2_000_000;
    let prepends = 0;
    let tabCycles = 0;
    const samples: Array<{ elapsedMs: number; simulatedMinutes: number; heapBytes: number; domNodes: number; documents: number; jsEventListeners: number; harnessRows: number; retainedStreamRows: number }> = [];
    const sample = async (elapsedMs: number): Promise<void> => {
        const heap = await collectHeapUsagePostGc(session);
        const dom = await sampleDomCountersMedian(session, 3);
        const harness = await page.evaluate(() => window.__jawTurnStreamFixture!.diagnostics());
        samples.push({ elapsedMs, simulatedMinutes: elapsedMs / SOAK_TIME_SCALE / 60_000, heapBytes: heap.usedSizeBytes, domNodes: dom.nodes, documents: dom.documents, jsEventListeners: dom.jsEventListeners, harnessRows: harness.rowCount, retainedStreamRows: harness.retainedStreamRows });
    };
    await sample(0);
    nextSampleAt = sampleIntervalMs;

    while (performance.now() - startedAt < durationMs) {
        const elapsedMs = performance.now() - startedAt;
        if (SOAK_STREAM_ENABLED) {
            streamId += 1;
            await page.evaluate((id) => window.__jawTurnStreamFixture!.append({
                id, role: 'assistant', content: `soak stream ${id}`, cli: 'codex', model: 'model-0', tool_log: null,
                trace_run_id: null, turn_id: `soak-${id}`, cost_usd: null, duration_ms: 42, working_dir: '/tmp/jaw-fixture',
                created_at: new Date(0).toISOString(), turn_segments: [],
            }), streamId);
        }
        if (SOAK_PREPEND_ENABLED && elapsedMs >= nextPrependAt) {
            prependId += 1;
            await page.evaluate((id) => window.__jawTurnStreamFixture!.prepend([{
                id, role: 'assistant', content: `soak prepend ${id}`, cli: 'codex', model: 'model-0', tool_log: null,
                trace_run_id: null, turn_id: `soak-prepend-${id}`, cost_usd: null, duration_ms: 42, working_dir: '/tmp/jaw-fixture',
                created_at: new Date(0).toISOString(), turn_segments: [],
            }]), prependId);
            prepends += 1;
            nextPrependAt += prependIntervalMs;
        }
        if (SOAK_TAB_CYCLE_ENABLED && elapsedMs >= nextTabAt) {
            await page.evaluate(() => window.__jawTurnStreamFixture!.cycleSidePaneTab());
            tabCycles += 1;
            nextTabAt += tabIntervalMs;
        }
        if (elapsedMs >= nextSampleAt) {
            await sample(elapsedMs);
            nextSampleAt += sampleIntervalMs;
        }
        const delayMs = Math.max(0, 50 - (performance.now() - startedAt - elapsedMs));
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await sample(durationMs);
    const slopeBytesPerHour = regressionSlopeBytesPerHour(samples, slopeWindowMinutes, SOAK_TIME_SCALE);
    const growthBytes = samples.at(-1)!.heapBytes - samples[0].heapBytes;
    const growthCapBytes = Math.max(16 * 1024 * 1024, samples[0].heapBytes * 0.1);
    const slopeCapBytesPerHour = 8 * 1024 * 1024;
    const harness = await page.evaluate(() => window.__jawTurnStreamFixture!.diagnostics());
    const report: Record<string, unknown> = { status: SOAK_MINUTES >= 60 && SOAK_TIME_SCALE === 1 ? 'PASS' : 'SANITY_PASS', runtime: 'headless-chrome', durationMinutes: SOAK_MINUTES, timeScale: SOAK_TIME_SCALE, contract: { streamHz: SOAK_STREAM_ENABLED ? 20 : 0, sampleEveryMinutes: 5, prependEveryMinutes: SOAK_PREPEND_ENABLED ? 5 : null, tabCycleEveryMinutes: SOAK_TAB_CYCLE_ENABLED ? 2 : null, slopeWindowMinutes: 30, slopeMinimumSamples: 7 }, drivers: { stream: SOAK_STREAM_ENABLED, prepend: SOAK_PREPEND_ENABLED, tabCycle: SOAK_TAB_CYCLE_ENABLED }, prepends, tabCycles, harness, growthBytes, growthCapBytes, slopeBytesPerHour, slopeCapBytesPerHour, samples };
    // Print before assertions so a failed gate retains its complete heap/DOM/
    // listener and harness-retention time series for RCA.
    console.log('[091 soak report]', JSON.stringify(report));
    assert.ok(slopeBytesPerHour <= slopeCapBytesPerHour, `heap slope ${slopeBytesPerHour}B/h <= ${slopeCapBytesPerHour}B/h`);
    assert.ok(growthBytes <= growthCapBytes, `heap growth ${growthBytes}B <= ${growthCapBytes}B`);
    assert.ok(harness.retainedStreamRows <= harness.streamRetentionCap, `fixture stream retention ${harness.retainedStreamRows} <= ${harness.streamRetentionCap}`);
    const browserIndex = browsers.indexOf(browser);
    if (browserIndex >= 0) browsers.splice(browserIndex, 1);
    const closeWithin = async (close: () => Promise<void>): Promise<'closed' | 'timeout'> => {
        const outcome = await Promise.race([
            close().then(() => 'closed' as const).catch(() => 'closed' as const),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
        ]);
        return outcome;
    };
    const cdpBrowserClose = await closeWithin(() => session.send('Browser.close').then(() => undefined));
    const pageClose = await closeWithin(() => page.close({ runBeforeUnload: false }));
    const contextClose = await closeWithin(() => context.close());
    const browserClose = await closeWithin(() => browser.close());
    report.teardown = {
        cdpBrowser: cdpBrowserClose,
        page: pageClose,
        context: contextClose,
        playwrightBrowser: browserClose,
        processClosed: cdpBrowserClose === 'closed' || browserClose === 'closed',
    };
    if (process.env.JAW_SOAK_WRITE_EVIDENCE !== '0') {
        const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as Record<string, unknown>;
        evidence.measuredAt = new Date().toISOString();
        evidence.soak = report;
        writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
    }
});

// keep referenced helpers "used" for lints when the browser test skips
void isOpenTurn; void isPromotionTurn;
