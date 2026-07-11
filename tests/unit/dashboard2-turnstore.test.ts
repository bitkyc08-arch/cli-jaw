// 042 — Windowed TurnStore 4-tier completion gates (doc §5).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { SegmentedMessageItem, TurnLifecycleSsePayload } from '../../src/shared/chat-events.ts';
import { createTurnStore, T1_OVERSCAN_TURNS } from '../../public/dashboard2/src/turn-stream/store/turn-store.ts';
import { attachSyncInvalidation } from '../../public/dashboard2/src/turn-stream/store/sync-turn-store.ts';
import { selectTurnIndex, selectWindowStubs } from '../../public/dashboard2/src/turn-stream/store/selectors.ts';
import type { TurnStreamAction } from '../../public/dashboard2/src/turn-stream/types.ts';
import { generateFixture, isOpenTurn, TURN_COUNT } from '../fixtures/dashboard2/turn-stream/seed.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const fixture = generateFixture();

function lifecycleActions(events: readonly TurnLifecycleSsePayload[]): TurnStreamAction[] {
    return events.map(payload => ({ kind: 'lifecycle', payload }));
}

function syntheticEnd(turnId: string, sessionId: string, turnSeq: number): TurnLifecycleSsePayload {
    return {
        topic: 'agent', event: 'turn_end',
        turnId, turnSeq, segmentId: `${turnId}:end`, sessionId,
        createdAt: 1_790_000_000_000, observedAt: 1_790_000_000_000, providerAt: null,
        fidelity: 'full', thinkingMarker: null, type: 'turn_end', status: 'done', detailRef: null,
    };
}

function syntheticLive(turnId: string): TurnLifecycleSsePayload[] {
    const base = {
        turnId, sessionId: 'fixture-session-0',
        createdAt: 1_790_000_001_000, observedAt: 1_790_000_001_000, providerAt: null,
        fidelity: 'full' as const, thinkingMarker: null, detailRef: null,
    };
    return [
        { topic: 'agent', event: 'turn_start', ...base, turnSeq: 1, segmentId: `${turnId}:start`, type: 'turn_start', status: 'running' },
        { topic: 'agent', event: 'turn_segment', ...base, turnSeq: 2, segmentId: `${turnId}:think`, type: 'thinking', status: 'running' },
    ];
}

/** ingest the full 040 fixture (lifecycle + history bodies), close every
 *  open turn, then add ONE live turn */
function buildStore10kPlus1() {
    const store = createTurnStore('3457/any');
    store.ingest(lifecycleActions(fixture.lifecycle));
    store.ingest({ kind: 'history_page', messages: fixture.messages });
    const closes: TurnLifecycleSsePayload[] = [];
    for (let i = 0; i < TURN_COUNT; i++) {
        if (!isOpenTurn(i)) continue;
        const turnId = `fixture-turn-${String(i).padStart(5, '0')}`;
        closes.push(syntheticEnd(turnId, `fixture-session-${i % 40}`, 99));
    }
    store.ingest(lifecycleActions(closes));
    store.ingest(lifecycleActions(syntheticLive('live-turn-000')));
    return store;
}

test('042: 10k committed + 1 live — tier caps hold and live key stays out of T0', () => {
    const store = buildStore10kPlus1();
    const stats = store.stats();
    assert.equal(stats.t0Count, TURN_COUNT);
    assert.equal(stats.liveCount, 1);
    const list = store.getListSnapshot();
    assert.equal(list.order.length, TURN_COUNT);
    assert.equal(selectTurnIndex(list, 'live-turn-000'), -1, 'live key not in T0 order');
    assert.ok(store.getLiveTurn('live-turn-000'));
    const window = store.getWindow(5000, 20);
    assert.ok(window.length <= 20 + 2 * T1_OVERSCAN_TURNS, `T1 window ${window.length} <= visible+80`);
    assert.equal(selectWindowStubs(store, 5000, 20).length, window.length);
    // T2 fills lazily; request 300 REAL bodies -> entries capped at 200 turns.
    // Use the newest assistant messages (the reducer keeps the newest 1024
    // hydrated bodies), and verify the bodies actually materialize.
    const assistantTurns = fixture.messages
        .filter(m => m.role === 'assistant' && m.turn_id)
        .slice(-300);
    let materialized = 0;
    for (const m of assistantTurns) {
        if (store.getBodySnapshot(m.turn_id!) !== null) materialized += 1;
    }
    assert.equal(materialized, 300, 'all requested bodies materialized from history');
    const after = store.stats();
    assert.ok(after.t2Turns > 0, 'T2 actually holds bodies');
    assert.ok(after.t2Turns <= 200, `T2 ${after.t2Turns} <= 200 turns`);
    assert.ok(after.t2Bytes <= 32 * 1024 * 1024, 'T2 <= 32MiB');
    assert.ok(after.t3Bytes <= 16 * 1024 * 1024, 'T3 <= 16MiB');
});

test('042: notification cardinality — single turn update notifies only its subscriber', () => {
    const store = buildStore10kPlus1();
    const counts = new Map<string, number>();
    const list = store.getListSnapshot();
    const targets = list.order.slice(100, 150);
    // pick a target turn that actually has an assistant history message
    const turnA = targets.find(id => fixture.messages.some(m => m.turn_id === id && m.role === 'assistant'))!;
    assert.ok(turnA, 'target turn with assistant message resolved');
    for (const turnId of targets) {
        counts.set(turnId, 0);
        store.subscribeTurn(turnId, () => counts.set(turnId, (counts.get(turnId) ?? 0) + 1));
    }
    let listCalls = 0;
    store.subscribeList(() => { listCalls += 1; });
    // update turn A's body via a single-message history page
    const message = fixture.messages.find(m => m.turn_id === turnA)!;
    const updated: SegmentedMessageItem = { ...message, content: `${message.content} (edited)` };
    store.ingest({ kind: 'history_page', messages: [updated] });
    assert.equal(counts.get(turnA), 1, 'turn A subscriber notified exactly once');
    for (const turnId of targets) {
        if (turnId === turnA) continue;
        assert.equal(counts.get(turnId), 0, 'other turns silent');
    }
    assert.equal(listCalls, 0, 'list subscriber silent on body update');
    // new committed turn insert notifies list once, existing turns stay silent
    store.ingest(lifecycleActions([
        ...syntheticLive('new-turn-001').map(e => ({ ...e, turnId: 'new-turn-001', segmentId: e.segmentId.replace('live-turn-000', 'new-turn-001') })),
        syntheticEnd('new-turn-001', 'fixture-session-0', 99),
    ]));
    assert.equal(listCalls, 1, 'list notified once for the new committed turn');
    for (const turnId of targets) assert.ok((counts.get(turnId) ?? 0) <= 1, 'no extra per-turn calls');
});

test('042: turn_end is one transaction — liveTurns -1 and T0 +1 in one notify batch', () => {
    const store = createTurnStore('3457/any');
    store.ingest(lifecycleActions(syntheticLive('tx-turn')));
    assert.equal(store.stats().liveCount, 1);
    assert.equal(store.stats().t0Count, 0);
    let listCalls = 0;
    let liveCalls = 0;
    store.subscribeList(() => {
        listCalls += 1;
        // observed mid-callback: the same commit already applied both sides
        assert.equal(store.stats().liveCount, 0);
        assert.equal(store.stats().t0Count, 1);
    });
    store.subscribeLive(() => { liveCalls += 1; });
    store.ingest({ kind: 'lifecycle', payload: syntheticEnd('tx-turn', 'fixture-session-0', 99) });
    assert.equal(listCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(store.getListSnapshot().order.includes('tx-turn'), true);
    assert.equal(store.getLiveTurn('tx-turn'), null);
});

test('042: byte budgets — +1 byte over T2 downgrades full→preview→…; T3 LRU evicts', () => {
    const mk = (i: number): SegmentedMessageItem => ({
        id: i, role: 'assistant', content: 'x'.repeat(900), cli: 'codex', model: null,
        tool_log: null, trace_run_id: null, turn_id: `budget-turn-${i}`, cost_usd: null,
        duration_ms: null, working_dir: '/tmp', created_at: new Date(0).toISOString(),
        turn_segments: [],
    });
    // calibrate: measure the exact bytes of two full bodies, then set the
    // limit ONE byte below -> exactly one enforcement step must fire
    const probe = createTurnStore('3457/any');
    probe.ingest({ kind: 'history_page', messages: [1, 2].map(mk) });
    probe.getBodySnapshot('budget-turn-1');
    probe.getBodySnapshot('budget-turn-2');
    const exactBytes = probe.stats().t2Bytes;
    const store = createTurnStore('3457/any', { t2MaxBytes: exactBytes - 1 });
    store.ingest({ kind: 'history_page', messages: [1, 2].map(mk) });
    store.getBodySnapshot('budget-turn-1');
    store.getBodySnapshot('budget-turn-2');
    assert.equal(store.getBodySnapshot('budget-turn-1')!.fidelity, 'preview', '+1 byte over: oldest downgrades full→preview');
    assert.equal(store.getBodySnapshot('budget-turn-2')!.fidelity, 'full', 'newest stays full');
    assert.ok(store.stats().t2Bytes <= exactBytes - 1, 'byte budget enforced');
    // count cap: 3 bodies with cap 2 -> oldest evicted outright (stub = T0 only)
    const countStore = createTurnStore('3457/any', { t2MaxTurns: 2 });
    countStore.ingest({ kind: 'history_page', messages: [1, 2, 3].map(mk) });
    for (let i = 1; i <= 3; i++) countStore.getBodySnapshot(`budget-turn-${i}`);
    assert.ok(countStore.stats().t2Turns <= 2, `count cap holds: ${countStore.stats().t2Turns}`);
    // T3: limit one byte below two details -> exactly the oldest evicts
    const t3probe = createTurnStore('3457/any');
    t3probe.putDetail('d1', 'y'.repeat(100));
    t3probe.putDetail('d2', 'y'.repeat(100));
    const t3bytes = t3probe.detailBytes();
    const t3store = createTurnStore('3457/any', { t3MaxBytes: t3bytes - 1 });
    t3store.putDetail('d1', 'y'.repeat(100));
    t3store.putDetail('d2', 'y'.repeat(100));
    assert.equal(t3store.hasDetail('d1'), false, 'oldest detail evicted');
    assert.equal(t3store.hasDetail('d2'), true);
    assert.ok(t3store.detailBytes() <= t3bytes - 1);
});

test('042: live budget pressure never deletes committed tiers', () => {
    const store = createTurnStore('3457/any', { liveBudgetBytes: 64 });
    store.ingest(lifecycleActions(syntheticLive('pressure-turn')));
    const before = store.stats();
    store.ingest({ kind: 'body_chunk', traceRunId: 'run-p', text: 'z'.repeat(500), textLen: 500 });
    const after = store.stats();
    assert.equal(after.liveBudgetPressure, true);
    assert.equal(store.getLiveSnapshot().liveBudgetPressure, true, 'pressure exposed on LIVE snapshot');
    assert.equal(after.t0Count, before.t0Count, 'T0 untouched');
    assert.equal(after.t2Turns, before.t2Turns, 'T2 untouched');
});

test('042: live-only updates never notify the list subscriber', () => {
    const store = createTurnStore('3457/any', { liveBudgetBytes: 64 });
    store.ingest(lifecycleActions(syntheticLive('quiet-turn')));
    let listCalls = 0;
    let liveCalls = 0;
    store.subscribeList(() => { listCalls += 1; });
    store.subscribeLive(() => { liveCalls += 1; });
    store.ingest({ kind: 'body_chunk', traceRunId: 'run-q', text: 'z'.repeat(200), textLen: 200 });
    assert.equal(listCalls, 0, 'list silent on live body/pressure update');
    assert.ok(liveCalls >= 1, 'live subscriber notified');
});

test('042: committed order is canonical — out-of-order turn_end arrival converges', () => {
    const build = (endsReversed: boolean) => {
        const store = createTurnStore('3457/any');
        const turns = ['order-a', 'order-b', 'order-c'];
        for (const turnId of turns) store.ingest(lifecycleActions(syntheticLive(turnId).map(e => ({
            ...e, turnId, segmentId: e.segmentId.replace('live-turn-000', turnId),
        }))));
        const ends = turns.map(turnId => syntheticEnd(turnId, 'fixture-session-0', 99));
        store.ingest(lifecycleActions(endsReversed ? [...ends].reverse() : ends));
        return store.getListSnapshot().order.join(',');
    };
    assert.equal(build(false), build(true), 'list order independent of turn_end arrival order');
});

test('042: stale scope fetch resolves after port_change are dropped', () => {
    const store = buildStore10kPlus1();
    const token = store.beginFetch();
    store.ingest({ kind: 'invalidation', reason: 'port_change' });
    const statsAfterSwitch = JSON.stringify(store.stats());
    let applied = false;
    const accepted = store.resolveFetch(token, () => { applied = true; });
    assert.equal(accepted, false);
    assert.equal(applied, false);
    assert.equal(JSON.stringify(store.stats()), statsAfterSwitch, 'store hash unchanged');
    assert.equal(store.stats().t0Count, 0, 'port_change disposed previous scope');
});

test('042: server 200 messages vs client 200 turns are independent counters', () => {
    const store = createTurnStore('3457/any');
    // 10 messages sharing ONE turn -> 1 T2 entry
    const shared: SegmentedMessageItem[] = Array.from({ length: 10 }, (_, i) => ({
        id: 1000 + i, role: 'assistant', content: `part ${i}`, cli: 'codex', model: null,
        tool_log: null, trace_run_id: null, turn_id: 'shared-turn', cost_usd: null,
        duration_ms: null, working_dir: '/tmp', created_at: new Date(0).toISOString(),
        turn_segments: [],
    }));
    // 5 messages with distinct turns -> 5 T2 entries
    const distinct: SegmentedMessageItem[] = Array.from({ length: 5 }, (_, i) => ({
        id: 2000 + i, role: 'assistant', content: `solo ${i}`, cli: 'codex', model: null,
        tool_log: null, trace_run_id: null, turn_id: `distinct-turn-${i}`, cost_usd: null,
        duration_ms: null, working_dir: '/tmp', created_at: new Date(0).toISOString(),
        turn_segments: [],
    }));
    store.ingest({ kind: 'history_page', messages: [...shared, ...distinct] });
    store.getBodySnapshot('shared-turn');
    for (let i = 0; i < 5; i++) store.getBodySnapshot(`distinct-turn-${i}`);
    assert.equal(store.stats().t2Turns, 6, 'T2 counts TURNS, not messages');
});

test('042: invalidation bridge forwards reasons without transport logic', () => {
    const store = createTurnStore('3457/any');
    store.ingest(lifecycleActions(fixture.lifecycle.slice(0, 40)));
    let handler: ((reason: 'replay_gap' | 'reconnect' | 'port_change') => void) | null = null;
    const detach = attachSyncInvalidation(store, (cb) => { handler = cb; return () => { handler = null; }; });
    handler!('replay_gap');
    assert.equal(store.getListSnapshot().needsBackfill, true);
    detach();
    assert.equal(handler, null, 'unsubscribe releases the provider hook');
});

test('042: traceRunId→turnId join maps a streaming body to its live turn', () => {
    const store = createTurnStore('3457/any');
    const live = syntheticLive('join-turn').map((e, idx) => idx === 1
        ? { ...e, type: 'tool', segmentId: 'join-turn:tool', detailRef: { traceRunId: 'join-run', traceSeq: 1 } }
        : e);
    store.ingest(lifecycleActions(live));
    store.ingest({ kind: 'body_chunk', traceRunId: 'join-run', text: 'streaming…', textLen: 10 });
    assert.equal(store.getLiveBodyForTurn('join-turn'), 'streaming…');
    assert.equal(store.getLiveBodyForTurn('other-turn'), null);
});

test('042: boundary contracts — no zustand, scope.tsx owns UI only, store owns no pane state', () => {
    const storeDir = join(ROOT, 'public/dashboard2/src/turn-stream/store');
    for (const rel of ['turn-store.ts', 'tier-budget.ts', 'selectors.ts', 'use-turn.ts', 'sync-turn-store.ts']) {
        const text = readFileSync(join(storeDir, rel), 'utf8');
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.ok(!/zustand/.test(code), `${rel} has no zustand`);
        assert.ok(!/EventSource|new WebSocket/.test(code), `${rel} has no transport`);
        assert.ok(!/sidePaneOpen|expandedPorts/.test(code), `${rel} does not own pane state`);
    }
    const scope = readFileSync(join(ROOT, 'public/dashboard2/src/state/scope.tsx'), 'utf8');
    assert.ok(!/TurnStore|liveTurns|tier-budget|lastEventId/.test(scope), 'scope.tsx holds no turn/LRU/cursor state');
    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    assert.ok(!/"zustand"/.test(pkg), 'no zustand dependency');
});
