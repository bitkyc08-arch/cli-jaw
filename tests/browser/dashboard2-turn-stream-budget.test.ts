// 040.2 — turn-stream fixture hash + CDP budget gate.
// Part 1 (always runs, node-only): fixture determinism, §3 distribution
// contract, manifest match, arrival-variant convergence, prod-bundle guard.
// Part 2 (browser; skips when no local Chrome/Chromium): DOM/heap/frame/anchor
// budgets + v4 shell assertions against the dev fixture surface.
// Parity evidence stays SYNTHETIC (034 §1.5) — real 3-runtime replay is 048.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    await Promise.allSettled(browsers.map(b => b.close()));
    await Promise.allSettled(servers.map(s => s.close()));
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
    report.heap = { before: heapBefore, after: heapAfter, growth, cap: Math.round(heapCap) };

    console.log('[040 budget report]', JSON.stringify(report));
});

// keep referenced helpers "used" for lints when the browser test skips
void isOpenTurn; void isPromotionTurn;
