// 041 — TurnStreamState reducer completion gates (doc §5).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TurnLifecycleSsePayload } from '../../src/shared/chat-events.ts';
import {
    createTurnStreamState, reduce, serializeState,
} from '../../public/dashboard2/src/turn-stream/reducer.ts';
import { rowKey } from '../../public/dashboard2/src/turn-stream/types.ts';
import {
    applyTextChunk, createIdempotencyState,
} from '../../public/dashboard2/src/turn-stream/idempotency.ts';
import {
    normalizeAgentDone, normalizeAgentOutput, normalizeAgentTool,
} from '../../public/dashboard2/src/turn-stream/hydrate.ts';
import { generateFixture } from '../fixtures/dashboard2/turn-stream/seed.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCOPE = '3457/fixture-session';

// bounded fixture slice: first 500 turns of the 040 deterministic fixture
const fixture = generateFixture();
const TURN_LIMIT = 500;
const lifecycleSlice = fixture.lifecycle.filter(e => Number(e.turnId.slice('fixture-turn-'.length)) < TURN_LIMIT);
const messageSlice = fixture.messages.filter(m => m.id <= TURN_LIMIT);

function reduceAll(events: TurnLifecycleSsePayload[], base = createTurnStreamState(SCOPE)) {
    let state = base;
    for (const payload of events) state = reduce(state, { kind: 'lifecycle', payload });
    return state;
}

test('041: canonical / reversed / duplicated / history-first / sse-first converge to one hash', () => {
    const canonical = reduceAll(lifecycleSlice);
    const canonicalWithHistory = reduce(canonical, { kind: 'history_page', messages: messageSlice });
    const hash = serializeState(canonicalWithHistory);

    // full reverse arrival
    const reversed = reduceAll([...lifecycleSlice].reverse());
    assert.equal(serializeState(reduce(reversed, { kind: 'history_page', messages: messageSlice })), hash);

    // every event duplicated (2x arrival)
    const doubled = reduceAll(lifecycleSlice.flatMap(e => [e, { ...e, sseReplay: true }]));
    assert.equal(serializeState(reduce(doubled, { kind: 'history_page', messages: messageSlice })), hash);

    // history-first then SSE
    let historyFirst = createTurnStreamState(SCOPE);
    historyFirst = reduce(historyFirst, { kind: 'history_page', messages: messageSlice });
    historyFirst = reduceAll(lifecycleSlice, historyFirst);
    assert.equal(serializeState(historyFirst), hash);
});

test('041: textLen partial overlap appends unseen tail; replay no-op; live backward resyncs', () => {
    let idem = createIdempotencyState();
    // establish applied=10 on run r1
    let out = applyTextChunk(idem, { traceRunId: 'r1', text: '0123456789', textLen: 10 });
    assert.equal(out.appendText, '0123456789');
    idem = out.state;
    // cumulative 13 with 6-char payload → only unseen 3-char tail appends
    out = applyTextChunk(idem, { traceRunId: 'r1', text: '789ABC', textLen: 13 });
    assert.equal(out.appendText, 'ABC');
    idem = out.state;
    // replayed same cumulative length → no-op
    out = applyTextChunk(idem, { traceRunId: 'r1', text: '789ABC', textLen: 13, sseReplay: true });
    assert.equal(out.appendText, null);
    assert.equal(out.resynced, false);
    idem = out.state;
    // LIVE chunk behind cursor → resync so the next chunk can progress
    out = applyTextChunk(idem, { traceRunId: 'r1', text: 'xy', textLen: 5 });
    assert.equal(out.appendText, null);
    assert.equal(out.resynced, true);
    idem = out.state;
    out = applyTextChunk(idem, { traceRunId: 'r1', text: '56789ABCDE', textLen: 15 });
    assert.equal(out.appendText, '56789ABCDE');
});

test('041: stale agent_done from finalized run A does not close live run B', () => {
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'body_chunk', traceRunId: 'run-A', text: 'a-body', textLen: 6 });
    state = reduce(state, { kind: 'agent_done', traceRunId: 'run-A', text: 'a-final' });
    state = reduce(state, { kind: 'body_chunk', traceRunId: 'run-B', text: 'b-live', textLen: 6 });
    const before = serializeState(state);
    const beforeLive = state.liveBodies['run-B'];
    // replayed stale done for A (already finalized) — must not touch B
    state = reduce(state, { kind: 'agent_done', traceRunId: 'run-A', text: 'a-replayed' });
    assert.equal(serializeState(state), before);
    assert.equal(state.liveBodies['run-B'], beforeLive);
    assert.equal(state.liveBodies['run-A'], 'a-final');
    assert.equal(state.diagnostics.droppedReplayCount >= 1, true);
});

test('041: tool replay same run/seq is no-op; employee tool does not adopt boss cursor', () => {
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'body_chunk', traceRunId: 'boss-run', text: 'hello', textLen: 5 });
    state = reduce(state, { kind: 'tool_event', traceRunId: 'boss-run', traceSeq: 1 });
    const afterFirst = state.diagnostics.droppedReplayCount;
    state = reduce(state, { kind: 'tool_event', traceRunId: 'boss-run', traceSeq: 1, sseReplay: true });
    assert.equal(state.diagnostics.droppedReplayCount, afterFirst + 1);
    // employee tool with its own run id must not replace the boss live cursor
    state = reduce(state, { kind: 'tool_event', traceRunId: 'emp-run', traceSeq: 1, isEmployee: true });
    const cont = reduce(state, { kind: 'body_chunk', traceRunId: 'boss-run', text: ' world', textLen: 11 });
    assert.equal(cont.liveBodies['boss-run'], 'hello world');
});

test('041: lifecycle conflict keeps first durable row and records one diagnostic', () => {
    const base = lifecycleSlice[1];
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'lifecycle', payload: base });
    const conflicting = { ...base, status: base.status === 'done' ? 'error' : 'done' };
    state = reduce(state, { kind: 'lifecycle', payload: conflicting });
    assert.equal(state.diagnostics.conflictCount, 1);
    assert.equal(state.rows[rowKey(base.turnId, base.turnSeq)].status, base.status);
});

test('041: replay_gap raises needsBackfill; only backfill_merged lowers it', () => {
    let state = reduceAll(lifecycleSlice.slice(0, 20));
    const rowsBefore = state.rowOrder.length;
    state = reduce(state, { kind: 'invalidation', reason: 'replay_gap' });
    assert.equal(state.needsBackfill, true);
    assert.equal(state.rowOrder.length, rowsBefore, 'replay_gap preserves durable rows');
    state = reduce(state, { kind: 'lifecycle', payload: lifecycleSlice[30] });
    assert.equal(state.needsBackfill, true, 'ordinary events do not lower the flag');
    state = reduce(state, { kind: 'backfill_merged' });
    assert.equal(state.needsBackfill, false);
});

test('041: reconnect resets partial cursors; port_change disposes scope state', () => {
    let state = reduceAll(lifecycleSlice.slice(0, 20));
    state = reduce(state, { kind: 'body_chunk', traceRunId: 'r1', text: 'partial', textLen: 7 });
    assert.equal(state.liveBodies['r1'], 'partial');
    const reconnected = reduce(state, { kind: 'invalidation', reason: 'reconnect' });
    assert.equal(Object.keys(reconnected.liveBodies).length, 0, 'partial live assembly reset');
    assert.equal(reconnected.rowOrder.length, state.rowOrder.length, 'durable rows survive reconnect');
    // after reset, a fresh cumulative chunk starts from zero cursor
    const resumed = reduce(reconnected, { kind: 'body_chunk', traceRunId: 'r1', text: 'fresh', textLen: 5 });
    assert.equal(resumed.liveBodies['r1'], 'fresh');
    const switched = reduce(state, { kind: 'invalidation', reason: 'port_change' });
    assert.equal(switched.rowOrder.length, 0, 'port_change starts an empty scope snapshot');
    assert.equal(Object.keys(switched.bodies).length, 0);
});

test('041: history message body is authoritative — live replay cannot overwrite it', () => {
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'history_page', messages: messageSlice });
    const turnId = messageSlice.find(m => m.role === 'assistant' && m.turn_id)!.turn_id!;
    assert.equal(state.bodies[turnId].provenance, 'message');
    const persisted = state.bodies[turnId].text;
    // re-hydrating the same page keeps the message body (merge precedence)
    state = reduce(state, { kind: 'history_page', messages: messageSlice });
    assert.equal(state.bodies[turnId].text, persisted);
    state = reduce(state, {
        kind: 'lifecycle',
        payload: {
            topic: 'agent', event: 'turn_segment', turnId, turnSeq: 99,
            segmentId: `${turnId}:live-detail`, sessionId: 'fixture-session-0',
            createdAt: 1_790_000_000_000, observedAt: 1_790_000_000_000,
            providerAt: null, fidelity: 'full', thinkingMarker: null,
            type: 'tool', status: 'done', detailRef: { traceRunId: 'late-live-run', traceSeq: 1 },
        },
    });
    state = reduce(state, { kind: 'agent_done', traceRunId: 'late-live-run', text: 'must not overwrite persisted' });
    assert.equal(state.bodies[turnId].text, persisted, 'message provenance beats later live promotion');
    assert.equal(state.bodies[turnId].provenance, 'message');
});

test('041: turn_end before agent_done retains a tool-less final response', () => {
    const base = {
        topic: 'agent' as const, sessionId: 'fixture-session-0',
        createdAt: 1_790_000_000_000, observedAt: 1_790_000_000_000,
        providerAt: null, fidelity: 'full' as const, thinkingMarker: null,
        detailRef: null,
    };
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_start', turnId: 'late-done-turn', turnSeq: 1,
        segmentId: 'late-done-turn:start', type: 'turn_start', status: 'running',
    } });
    state = reduce(state, { kind: 'body_chunk', traceRunId: 'late-done-run', text: 'final text', textLen: 10 });
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_end', turnId: 'late-done-turn', turnSeq: 2,
        segmentId: 'late-done-turn:end', type: 'turn_end', status: 'done',
    } });
    assert.equal(state.bodies['late-done-turn'], undefined);
    state = reduce(state, { kind: 'agent_done', traceRunId: 'late-done-run', text: 'final text' });
    assert.equal(state.runToTurn['late-done-run'], 'late-done-turn');
    assert.equal(state.bodies['late-done-turn']?.text, 'final text');
    assert.equal(state.bodies['late-done-turn']?.provenance, 'live');
});

test('041: late done for terminal A never attaches its body to newly live B', () => {
    const base = {
        topic: 'agent' as const, sessionId: 'fixture-session-0',
        createdAt: 1_790_000_000_000, observedAt: 1_790_000_000_000,
        providerAt: null, fidelity: 'full' as const, thinkingMarker: null,
        detailRef: null,
    };
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_start', turnId: 'turn-A', turnSeq: 1,
        segmentId: 'turn-A:start', type: 'turn_start', status: 'running',
    } });
    state = reduce(state, { kind: 'body_chunk', traceRunId: 'run-A', text: 'A body', textLen: 6 });
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_end', turnId: 'turn-A', turnSeq: 2,
        segmentId: 'turn-A:end', type: 'turn_end', status: 'done',
    } });
    assert.equal(state.runToTurn['run-A'], 'turn-A', 'turn_end captures the active run before the next turn starts');
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_start', turnId: 'turn-B', turnSeq: 1,
        segmentId: 'turn-B:start', type: 'turn_start', status: 'running',
    } });
    state = reduce(state, { kind: 'agent_done', traceRunId: 'run-A', text: 'A final' });
    assert.equal(state.bodies['turn-A']?.text, 'A final');
    assert.equal(state.bodies['turn-B'], undefined);
    assert.equal(state.runToTurn['run-A'], 'turn-A');
});

test('041: no-body pending A and live B remain unjoined instead of cross-linking B to A', () => {
    const base = {
        topic: 'agent' as const, sessionId: 'fixture-session-0',
        createdAt: 1_790_000_000_000, observedAt: 1_790_000_000_000,
        providerAt: null, fidelity: 'full' as const, thinkingMarker: null,
        detailRef: null,
    };
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_start', turnId: 'empty-A', turnSeq: 1,
        segmentId: 'empty-A:start', type: 'turn_start', status: 'running',
    } });
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_end', turnId: 'empty-A', turnSeq: 2,
        segmentId: 'empty-A:end', type: 'turn_end', status: 'done',
    } });
    state = reduce(state, { kind: 'lifecycle', payload: {
        ...base, event: 'turn_start', turnId: 'live-B', turnSeq: 1,
        segmentId: 'live-B:start', type: 'turn_start', status: 'running',
    } });
    state = reduce(state, { kind: 'agent_done', traceRunId: 'run-B', text: 'B final' });
    assert.equal(state.runToTurn['run-B'], undefined, 'ambiguous pending/live candidates fail closed');
    assert.equal(state.bodies['empty-A'], undefined);
    assert.equal(state.bodies['live-B'], undefined);
});

test('041: pure boundary — no window/document/fetch/react imports in pure modules', () => {
    for (const rel of ['reducer.ts', 'idempotency.ts', 'hydrate.ts', 'types.ts']) {
        const text = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream', rel), 'utf8');
        assert.ok(!/\bfrom ['"]react['"]|window\.|document\.|fetch\(/.test(text), `${rel} stays pure`);
        assert.ok(!/\bjwc\b/.test(text), `${rel} has no jwc import`);
    }
});

test('041: row key factory only accepts (turnId, turnSeq)', () => {
    assert.equal(rowKey('t', 3), 't#3');
    // compile-time: rowKey has exactly two parameters
    assert.equal(rowKey.length, 2);
});

test('041: invariant 2 — other-scope events leave the state hash unchanged', () => {
    let state = createTurnStreamState('3457/fixture-session-0', 'fixture-session-0');
    const own = lifecycleSlice.find(e => e.sessionId === 'fixture-session-0')!;
    const foreign = lifecycleSlice.find(e => e.sessionId === 'fixture-session-1')!;
    state = reduce(state, { kind: 'lifecycle', payload: own });
    const hash = serializeState(state);
    const after = reduce(state, { kind: 'lifecycle', payload: foreign });
    assert.equal(serializeState(after), hash);
    assert.equal(after.rowOrder.length, 1);
});

test('041: legacy body-channel ingress normalizers feed the reducer without the legacy union', () => {
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, normalizeAgentOutput({
        topic: 'agent', event: 'agent_output', text: 'hello', textLen: 5, traceRunId: 'run-N',
    }));
    state = reduce(state, normalizeAgentTool({
        topic: 'agent', event: 'agent_tool', traceRunId: 'run-N', traceSeq: 1,
        icon: '', label: 'Bash', detail: '', status: 'running',
    } as Parameters<typeof normalizeAgentTool>[0]));
    state = reduce(state, normalizeAgentDone({
        topic: 'agent', event: 'agent_done', text: 'hello world', traceRunId: 'run-N',
    }));
    assert.equal(state.liveBodies['run-N'], 'hello world');
    // finalized: replayed output for the run is now a no-op
    const after = reduce(state, normalizeAgentOutput({
        topic: 'agent', event: 'agent_output', text: 'zzz', textLen: 8, traceRunId: 'run-N', sseReplay: true,
    }));
    assert.equal(after.liveBodies['run-N'], 'hello world');
});

test('041: liveBodies stay bounded across many runs, including agent_done finalize', () => {
    let state = createTurnStreamState(SCOPE);
    for (let i = 0; i < 40; i++) {
        state = reduce(state, { kind: 'body_chunk', traceRunId: `bulk-run-${i}`, text: 'body', textLen: 4 });
        state = reduce(state, { kind: 'agent_done', traceRunId: `bulk-run-${i}`, text: 'final' });
    }
    assert.ok(Object.keys(state.liveBodies).length <= 16, `liveBodies ring bounded: ${Object.keys(state.liveBodies).length}`);
});

test('048: turn_id=null legacy rows keep their text with empty segments', () => {
    let state = createTurnStreamState(SCOPE);
    state = reduce(state, { kind: 'history_page', messages: messageSlice });
    const legacyUser = messageSlice.find(m => m.turn_id === null || (m.role === 'user' && !m.turn_id));
    assert.ok(legacyUser, 'fixture carries turn-less rows');
    assert.equal(state.legacyMessages[legacyUser.id]?.content, legacyUser.content, 'legacy text preserved');
    assert.equal(legacyUser.turn_segments.length, 0, 'legacy row has empty segments');
});
