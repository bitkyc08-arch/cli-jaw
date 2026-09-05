import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrintActivityProjection } from '../../src/agent/runtime/print-projection.js';
import { createPrintActivity } from '../../src/agent/runtime/print-activity.js';
import { startTraceRun, finalizeTraceRun } from '../../src/trace/store.js';
import { readActivityPage } from '../../src/trace/activity-journal.js';
import { subscribe, type BusEvent } from '../../src/core/event-bus.js';
import { settings } from '../../src/core/config.js';
import { emitAgentTool } from '../../src/agent/events/helpers.js';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.js';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.js';
import type { SpawnContext } from '../../src/types/agent.js';

test('pure observer keeps message boundaries, operations, unknown phase and stable tool references', () => {
    const seen: RuntimeEventBody[] = [];
    const observer = createPrintActivityProjection(body => seen.push(body));
    observer.message('A', 'append'); observer.message('B', 'append'); observer.nextMessage();
    observer.message('commentary', 'replace', 'commentary');
    observer.reasoning('think', 'append'); observer.reasoning(' more', 'append');
    observer.tool({ icon: 'x', label: 'cmd', toolType: 'tool', stepRef: 'stable', status: 'running' });
    observer.tool({ icon: 'x', label: 'cmd', toolType: 'tool', stepRef: 'stable', status: 'done', detail: '' });
    assert.equal(seen[0]?.kind, 'message');
    assert.equal(seen[0]?.kind === 'message' && seen[0].phase, 'unknown');
    assert.equal(seen[0]?.kind === 'message' && seen[0].itemId, seen[1]?.kind === 'message' && seen[1].itemId);
    assert.notEqual(seen[0]?.kind === 'message' && seen[0].itemId, seen[2]?.kind === 'message' && seen[2].itemId);
    assert.equal(seen[3]?.kind === 'reasoning' && seen[3].itemId, seen[4]?.kind === 'reasoning' && seen[4].itemId);
    assert.equal(seen[5]?.kind === 'tool' && seen[5].itemId, seen[6]?.kind === 'tool' && seen[6].itemId);
    assert.equal(seen[6]?.kind === 'tool' && seen[6].detail, '');
});

test('anonymous tools stay distinct; narration and thinking never become real tools', () => {
    const seen: RuntimeEventBody[] = [];
    const observer = createPrintActivityProjection(body => seen.push(body));
    observer.tool({ icon: '💬', label: 'narration', toolType: 'thinking' });
    observer.tool({ icon: '💭', label: 'thought', toolType: 'thinking' });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool' });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool' });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool', traceSeq: 2 });
    observer.tool({ icon: 'x', label: 'same', toolType: 'tool', stepRef: 'trace:2' });
    assert.deepEqual(seen.map(e => e.kind), ['message', 'reasoning', 'tool', 'tool', 'tool', 'tool']);
    assert.equal(new Set(seen.filter(e => e.kind === 'tool').map(e => e.itemId)).size, 4);
});

test('pure observer finishes exactly once and contains a throwing sink', t => {
    const seen: RuntimeEventBody[] = [];
    const observer = createPrintActivityProjection(body => seen.push(body));
    observer.finish({ kind: 'turn-end', status: 'done', finalText: '' });
    observer.finish({ kind: 'turn-end', status: 'done', finalText: 'late' });
    observer.message('late', 'append');
    assert.deepEqual(seen, [{ kind: 'turn-end', status: 'done', finalText: '' }]);
    t.mock.method(console, 'warn', () => {});
    let calls = 0;
    const failed = createPrintActivityProjection(() => { calls++; throw new Error('fixture'); });
    assert.doesNotThrow(() => { failed.message('A', 'append'); failed.message('B', 'append'); failed.finish({ kind: 'turn-end', status: 'error', finalText: null }); });
    assert.equal(calls, 1);
});

test('factory uses actual journal and preserves selected null/empty/whitespace application finals', () => {
    for (const finalText of [null, '', ' \n', 'selected final']) {
        const runId = startTraceRun({ cli: 'print', sessionId: 'default', scopeKey: 'default' });
        const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'print');
        observer.message('unfinished narration', 'append');
        observer.finish({ kind: 'turn-end', status: 'done', finalText }); finalizeTraceRun(runId, 'done');
        const p = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!;
        const end = p.events.at(-1);
        assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, finalText); assert.equal(p.incomplete, false);
        assert.equal(p.events.filter(e => e.kind === 'turn-start').length, 1);
    }
});

test('preview capacity fails visibly through one gap, with no fabricated terminal', () => {
    const seen: BusEvent[] = []; const unsubscribe = subscribe(e => seen.push(e));
    const runId = startTraceRun({ cli: 'print', sessionId: 'default', scopeKey: 'default' });
    try {
        const observer = createPrintActivity({ runId, sessionId: 'default', scope: 'default', turnId: runId, audience: 'public' }, 'print');
        observer.message('x'.repeat(4000), 'append'); observer.message('late', 'append');
        observer.finish({ kind: 'turn-end', status: 'done', finalText: 'still selected by lifecycle' });
        const p = readActivityPage({ runId, sessionId: 'default', after: 0, limit: 40 })!;
        assert.equal(p.incomplete, true); assert.equal(p.loss, 'run_limit');
        assert.equal(p.events.some(e => e.kind === 'turn-end'), false);
        assert.equal(seen.filter(e => e.event === 'agent_runtime_gap').length, 1);
    } finally { unsubscribe(); }
});

function context(): SpawnContext {
    return { fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(), hasClaudeStreamEvents: false,
        sessionId: 'native-private', cost: null, turns: null, duration: null, tokens: null, stderrBuf: '',
        traceRunId: 'tr_captured1234567890', activityIdentity: { sessionId: 'jaw-captured', scope: 'captured-scope' } };
}

test('tool wire identity is captured after payload overrides even with multi-session disabled', () => {
    const before = settings.multiSession.enabled; settings.multiSession.enabled = false;
    const seen: BusEvent[] = []; const legacy: Record<string, unknown>[] = [];
    const unsubscribe = subscribe(e => seen.push(e));
    const listener = (_type: string, data: Record<string, unknown>) => legacy.push(data);
    addBroadcastListener(listener);
    try {
        const ctx = context();
        emitAgentTool(ctx, 'fixture', { icon: 'x', label: 'cmd', toolType: 'tool', traceRunId: 'spoof', sessionId: 'spoof', scope: 'spoof' },
            { sessionId: 'emp-spoof', scope: 'emp-spoof', traceRunId: 'emp-spoof' });
        assert.equal(seen[0]?.data['sessionId'], 'jaw-captured'); assert.equal(seen[0]?.data['scope'], 'captured-scope');
        assert.equal(seen[0]?.data['traceRunId'], ctx.traceRunId);
        assert.ok(!JSON.stringify(seen).includes('native-private'));
        ctx.traceAudience = 'internal'; emitAgentTool(ctx, undefined, { icon: 'x', label: 'cmd', toolType: 'tool' }, {});
        assert.equal(seen.length, 1, 'internal audience has no public SSE');
        assert.equal(legacy.length, 2, 'legacy internal listener contract remains');
    } finally { unsubscribe(); removeBroadcastListener(listener); settings.multiSession.enabled = before; }
});
