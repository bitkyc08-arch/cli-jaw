import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { PiRuntimeEvent } from '../../src/agent/pi-runtime.ts';
import type { ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';

type Callbacks = { onEvent?: (event: PiRuntimeEvent) => void; onRawRecord?: (record: unknown) => void; cwd?: string };
const fixture = {
    mode: 'ok' as 'ok' | 'acquire-failure' | 'direct-failure' | 'turn-failure' | 'raw-limit' | 'lifecycle-failure' | 'turn-lifecycle-failure',
    calls: [] as Callbacks[], acquisitions: [] as Array<Record<string, unknown>>,
    direct: 0, releases: 0, watchdogStops: 0,
    acquireGate: null as Promise<void> | null,
    contexts: [] as RuntimeEventContext[], events: [] as RuntimeEvent[],
    lifecycle: [] as ExitHandlerParams[], legacy: [] as Array<{ type: string; data: Record<string, unknown> }>,
};

// Keep normalization/capability exports real; only launch and availability are fake.
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: {
    ...config, detectCli: () => ({ available: true, path: null }),
} });
const runtimeEvents = await import('../../src/agent/runtime/events.ts');
test.mock.module('../../src/agent/runtime/events.js', { namedExports: {
    ...runtimeEvents,
    recordRuntimeEvent: (context: RuntimeEventContext, body: RuntimeEventBody) => {
        fixture.contexts.push({ ...context });
        const event = runtimeEvents.recordRuntimeEvent(context, body);
        if (event) fixture.events.push(event);
        return event;
    },
} });

function child(): ChildProcess {
    // No real PID: cleanup cannot accidentally signal a host process.
    return Object.assign(new EventEmitter(), {
        pid: undefined, exitCode: null, signalCode: null, killed: false,
        stdin: Object.assign(new EventEmitter(), { write: () => true, end() {} }),
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
    }) as unknown as ChildProcess;
}
async function protocol(callbacks: Callbacks) {
    fixture.calls.push(callbacks);
    if (fixture.mode === 'turn-failure' || fixture.mode === 'turn-lifecycle-failure') throw new Error('fixture Pi turn failed');
    const raw = (record: unknown) => callbacks.onRawRecord?.(record);
    const semantic = (event: PiRuntimeEvent) => callbacks.onEvent?.(event);
    if (fixture.mode === 'raw-limit') raw({ type: 'fixture_oversize', payload: 'x'.repeat(70_000) });
    raw({ type: 'message_start', message: { role: 'assistant' } });
    semantic({ kind: 'session', sessionId: 'provider-session-private' });
    raw({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'consider' } });
    semantic({ kind: 'thinking', text: 'consider' });
    raw({ type: 'tool_execution_start', toolCallId: 'provider-tool-private', toolName: 'bash',
        args: { command: 'printf fixture', password: 'RAW_SECRET_CANARY' } });
    raw({ type: 'tool_execution_update', toolCallId: 'provider-tool-private', toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: 'part' }] } });
    raw({ type: 'tool_execution_end', toolCallId: 'provider-tool-private', toolName: 'bash',
        result: { content: [{ type: 'text', text: 'complete' }, { type: 'image', data: 'IMAGE_MUST_NOT_PROJECT' }] } });
    semantic({ kind: 'tool', label: 'bash', status: 'done', detail: 'legacy tool detail' });
    raw({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello ' } });
    semantic({ kind: 'text', text: 'Hello ' });
    raw({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Pi' } });
    semantic({ kind: 'text', text: 'Pi' });
    raw({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'unaccepted raw snapshot' }] }] });
    return { text: 'adapter fallback must not overwrite stream', stderr: '', code: 0, sessionId: 'provider-session-private' };
}
const pi = await import('../../src/agent/pi-runtime.ts');
test.mock.module('../../src/agent/pi-runtime.js', { namedExports: {
    ...pi,
    spawnPiRpc: (_profile: unknown, _settings: unknown, callbacks: Callbacks) => {
        fixture.direct++;
        if (fixture.mode === 'direct-failure') { fixture.calls.push(callbacks); throw new Error('fixture direct creation failed'); }
        return { child: child(), done: Promise.resolve().then(() => protocol(callbacks)) };
    },
} });
const pool = await import('../../src/agent/runtime-pool.ts');
test.mock.module('../../src/agent/runtime-pool.js', { namedExports: {
    ...pool,
    acquirePiRuntime: async (options: Record<string, unknown>) => {
        fixture.acquisitions.push(options);
        if (fixture.acquireGate) await fixture.acquireGate;
        if (fixture.mode === 'acquire-failure') throw new Error('fixture acquire failed');
        return {
            reused: false, sessionId: 'provider-session-private',
            session: { child: child(), sessionId: 'provider-session-private', alive: true,
                sendPrompt: (_prompt: string, callbacks: Callbacks) => Promise.resolve().then(() => protocol(callbacks)) },
            release: () => { fixture.releases++; }, cancel: async () => {},
        };
    },
} });
const watchdog = await import('../../src/agent/watchdog.ts');
test.mock.module('../../src/agent/watchdog.js', { namedExports: {
    ...watchdog, attachWatchdog: () => ({ markProgress() {}, extendDeadline() {}, stop() { fixture.watchdogStops++; } }),
} });
const traces = await import('../../src/trace/store.ts');
const { db } = await import('../../src/core/db.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
const live = await import('../../src/agent/live-run-state.ts');
const lifecycle = await import('../../src/agent/lifecycle-handler.ts');
test.mock.module('../../src/agent/lifecycle-handler.js', { namedExports: {
    ...lifecycle,
    handleAgentExit: async (params: ExitHandlerParams) => {
        fixture.lifecycle.push(params);
        const finalText = params.code === 0 ? 'lifecycle-selected final' : null;
        params.onRuntimeEnd?.({ kind: 'turn-end', status: params.code === 0 ? 'done' : 'error', finalText });
        params.activeProcesses.delete(params.agentLabel);
        params.releaseMainRun(params.scopeKey, params.childProcess, params.ownerGeneration);
        live.clearLiveRun(params.ctx.liveScope || 'default');
        traces.finalizeTraceRun(params.ctx.traceRunId, params.code === 0 ? 'done' : 'error');
        if (fixture.mode === 'turn-lifecycle-failure') throw new Error('fixture failed lifecycle before caller resolution');
        params.resolve({ text: finalText ?? '', code: params.code ?? 0, tools: params.ctx.toolLog });
        if (fixture.mode === 'lifecycle-failure') throw new Error('fixture failure after finalization');
    },
} });
const { spawnAgent, activeProcesses, activeMainProcesses, armExitSettle, waitForExitSettled, settleExit } = await import('../../src/agent/spawn.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const legacyListener = (type: string, data: Record<string, unknown>) => { fixture.legacy.push({ type, data }); };
const publicEvents: string[] = [];
let unsubscribe = () => {};

test.beforeEach(() => {
    db.prepare("INSERT OR IGNORE INTO chat_sessions(id,seq,label) VALUES('jaw-chat-id',9001,'Pi owned fixture')").run();
    fixture.mode = 'ok'; fixture.calls.length = 0; fixture.acquisitions.length = 0;
    fixture.contexts.length = 0; fixture.events.length = 0; fixture.lifecycle.length = 0; fixture.legacy.length = 0;
    fixture.direct = 0; fixture.releases = 0; fixture.watchdogStops = 0; publicEvents.length = 0;
    fixture.acquireGate = null;
    activeMainProcesses.clear(); activeProcesses.clear();
    config.settings['workingDir'] = process.env['CLI_JAW_HOME']!;
    mkdirSync(join(config.settings['workingDir'], 'prompts'), { recursive: true });
    config.settings['fallbackOrder'] = []; config.settings['activeOverrides'] = {};
    config.settings['pi'] = pi.normalizePiSettings(pi.DEFAULT_PI_SETTINGS);
    config.settings['perCli'] = { ...config.settings['perCli'], pi: { model: 'fixture-pi', effort: 'high', provider: 'progrok' } };
    config.settings['multiSession'] = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer',
        channels: { telegram: true, discord: true, slack: true } };
    addBroadcastListener(legacyListener);
    unsubscribe = subscribe(event => { if (event.event === 'agent_runtime' || event.event === 'agent_runtime_gap') publicEvents.push(event.event); });
});
test.afterEach(() => { removeBroadcastListener(legacyListener); unsubscribe(); });
function opts(employee = false) {
    return { cli: 'pi', model: 'fixture-pi', effort: 'high', scopeKey: 'pi-test-scope', chatSessionId: 'jaw-chat-id',
        requestId: 'pi-test-request', runtimeParentItemId: 'jaw-parent-item', origin: 'web',
        sysPrompt: employee ? 'employee fixture instructions' : '', _skipInsert: true, _skipHistory: true,
        _skipResume: true, _isSmokeContinuation: true, ...(employee ? { agentId: 'pi-fixture-worker' } : {}) };
}
function assertCanonicalContext(employee: boolean) {
    assert.ok(fixture.events.length > 0, 'real spawn must feed the shared runtime emitter');
    const runId = fixture.events[0]!.runId;
    const owner = traces.getTraceRun(runId);
    assert.equal(owner?.session_id, 'jaw-chat-id');
    assert.equal(owner?.scope_key, 'pi-test-scope');
    const replay = readActivityPage({ runId, sessionId: 'jaw-chat-id', after: 0, limit: 40 });
    if (employee) assert.equal(replay, null, 'internal trace stays private despite captured owner');
    else assert.deepEqual(replay?.events, fixture.events, 'actual spawn, emitter, stored codec and replay agree');
    for (const context of fixture.contexts) {
        assert.equal(context.sessionId, 'jaw-chat-id'); assert.equal(context.scope, 'pi-test-scope');
        assert.equal(context.parentItemId, 'jaw-parent-item');
        assert.equal(context.audience, employee ? 'internal' : 'public');
        assert.equal(context.turnId, context.runId);
    }
    assert.equal(fixture.events.filter(e => e.kind === 'turn-start').length, 1);
    assert.equal(fixture.events.filter(e => e.kind === 'turn-end').length, 1);
    assert.doesNotMatch(JSON.stringify(fixture.events), /RAW_SECRET_CANARY|IMAGE_MUST_NOT_PROJECT|provider-session-private|provider-tool-private/);
}

for (const employee of [false, true]) {
    test(`real Pi ${employee ? 'employee direct' : 'main pooled'} spawn wires raw, semantic and lifecycle observers`, async () => {
        const run = spawnAgent('fixture prompt', opts(employee));
        assert.equal(Boolean(run.child), employee);
        const result = await run.promise;
        assert.equal(result.text, 'lifecycle-selected final'); assert.equal(result.code, 0);
        assert.equal(fixture.direct, employee ? 1 : 0); assert.equal(fixture.acquisitions.length, employee ? 0 : 1);
        assert.equal(fixture.releases, employee ? 0 : 1); assert.equal(fixture.watchdogStops, 1);
        assert.equal(typeof fixture.calls[0]?.onRawRecord, 'function'); assert.equal(typeof fixture.calls[0]?.onEvent, 'function');
        assert.equal(fixture.lifecycle.length, 1); assert.equal(typeof fixture.lifecycle[0]?.onRuntimeEnd, 'function');
        assert.equal(fixture.lifecycle[0]?.ctx.fullText, 'Hello Pi');
        assert.equal(fixture.lifecycle[0]?.ctx.sessionId, 'provider-session-private');
        assert.equal(fixture.lifecycle[0]?.ctx.runtimeOutcome, undefined, 'Pi preserves its existing legacy outcome contract');
        assert.equal(fixture.lifecycle[0]?.ctx.toolLog.filter(tool => tool.label === 'bash').length, 1);
        assertCanonicalContext(employee);
        assert.equal(fixture.events.at(-1)?.kind, 'turn-end');
        assert.equal((fixture.events.at(-1) as Extract<RuntimeEvent, { kind: 'turn-end' }>).finalText, 'lifecycle-selected final');
        const tools = fixture.events.filter((e): e is Extract<RuntimeEvent, { kind: 'tool' }> => e.kind === 'tool');
        assert.deepEqual(tools.map(e => e.status), ['running', 'running', 'done']);
        assert.equal(new Set(tools.map(e => e.itemId)).size, 1);
        assert.equal(tools.at(-1)?.output, 'complete');
        const messages = fixture.events.filter((e): e is Extract<RuntimeEvent, { kind: 'message' }> => e.kind === 'message');
        assert.ok(messages.length > 0); assert.ok(messages.every(e => e.phase === 'unknown'));
        assert.equal(messages.at(-1)?.text, 'Hello Pi');
        assert.equal(fixture.legacy.filter(e => e.type === 'agent_output').map(e => e.data['text']).join(''), 'Hello Pi');
        const rows = traces.listTraceEvents(fixture.events[0]!.runId, 0, 200).events;
        assert.ok(rows.some(row => row.event_type === 'pi_rpc:tool_execution_start' && row.source === 'cli_raw'));
        assert.ok(rows.find(row => row.event_type === 'pi_rpc:tool_execution_start')!.seq < tools[0]!.seq);
        assert.equal(activeMainProcesses.has('pi-test-scope'), false); assert.equal(activeProcesses.has('pi-fixture-worker'), false);
        if (employee) { assert.equal(publicEvents.length, 0); assert.equal(existsSync(fixture.calls[0]!.cwd!), false); }
        else assert.ok(publicEvents.includes('agent_runtime'));
    });
}

test('Pi raw budget loss keeps canonical final, accepted tools and legacy result alive', async () => {
    fixture.mode = 'raw-limit';
    const result = await spawnAgent('budget fixture', opts()).promise;
    assert.equal(result.text, 'lifecycle-selected final'); assertCanonicalContext(false);
    assert.equal(publicEvents.includes('agent_runtime_gap'), false, 'retention loss is not persistence failure');
    const rows = traces.listTraceEvents(fixture.events[0]!.runId, 0, 200).events;
    assert.equal(rows.filter(row => row.event_type === 'pi_rpc:raw_retention_limited').length, 1);
    assert.equal(rows.filter(row => row.event_type === 'pi_rpc:agent_end').length, 1);
    assert.ok(rows.filter(row => row.source === 'cli_raw').reduce((bytes, row) => bytes + (row.bytes ?? 0), 0) <= 4 * 1024 * 1024);
    assert.ok(fixture.events.some(e => e.kind === 'tool' && e.status === 'done'));
    assert.equal(fixture.lifecycle[0]?.ctx.fullText, 'Hello Pi');
});

test('rejected Pi turn uses error lifecycle observer once and releases pooled lease', async () => {
    fixture.mode = 'turn-failure';
    const result = await spawnAgent('failure fixture', opts()).promise;
    assert.equal(result.code, 1); assert.equal(fixture.releases, 1); assert.equal(fixture.watchdogStops, 1);
    assert.equal(fixture.lifecycle.length, 1); assert.equal(typeof fixture.lifecycle[0]?.onRuntimeEnd, 'function');
    assertCanonicalContext(false);
    assert.ok(fixture.events.some(e => e.kind === 'turn-end' && e.status === 'error' && e.finalText === null));
    assert.equal(activeMainProcesses.has('pi-test-scope'), false);
});

test('Pi lifecycle rejection after finalization cannot execute lifecycle or release twice', async () => {
    fixture.mode = 'lifecycle-failure';
    const result = await spawnAgent('lifecycle fixture', opts()).promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result.text, 'lifecycle-selected final');
    assert.equal(fixture.lifecycle.length, 1);
    assert.equal(fixture.releases, 1);
    assert.equal(fixture.events.filter(event => event.kind === 'turn-end').length, 1);
});
test('Pi execution failure followed by lifecycle rejection resolves caller once and settles barrier', async () => {
    fixture.mode = 'turn-lifecycle-failure';
    const scope = 'pi-test-scope';
    armExitSettle(scope);
    let barrierDone = false;
    const barrier = waitForExitSettled(scope).then(() => { barrierDone = true; });
    const result = await spawnAgent('double failure fixture', opts()).promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result.code, 1); assert.equal(result.text, '');
    assert.equal(fixture.lifecycle.length, 1); assert.equal(fixture.releases, 1);
    assert.equal(barrierDone, true);
    assert.equal(fixture.events.filter(event => event.kind === 'turn-end').length, 1);
    await barrier;
});

test('Pi acquire failure closes trace/live state and settles the armed exit barrier without timeout', async context => {
    fixture.mode = 'acquire-failure';
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const scope = 'pi-test-scope';
    armExitSettle(scope);
    let settled = false;
    const barrier = waitForExitSettled(scope).then(() => { settled = true; });
    try {
        await Promise.resolve();
        assert.equal(settled, false, 'the waiter must observe an armed, unresolved barrier');
        const result = await spawnAgent('acquire fixture', opts()).promise;
        // Drain promise continuations via one event-loop turn. Fake setTimeout
        // is NEVER advanced: the waiter's fallback deadline cannot pass this.
        await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.equal(settled, true, 'acquire cleanup must call settleExit, not rely on waiter timeout');
        assert.equal(result.code, 1); assertCanonicalContext(false);
        assert.equal(fixture.lifecycle.length, 0); assert.equal(fixture.releases, 0);
        assert.equal(activeMainProcesses.has(scope), false);
        assert.equal(live.getLiveRun(scope).running, false);
        assert.equal(traces.getTraceRun(fixture.events[0]!.runId)?.status, 'error');
    } finally {
        settleExit(scope);
        await barrier;
        context.mock.timers.reset();
    }
});

test('synchronous employee Pi creation failure closes trace and removes its temporary cwd', () => {
    fixture.mode = 'direct-failure';
    assert.throws(() => spawnAgent('direct fixture', opts(true)), /fixture direct creation failed/);
    assertCanonicalContext(true);
    assert.equal(fixture.lifecycle.length, 0); assert.equal(fixture.acquisitions.length, 0);
    assert.equal(existsSync(fixture.calls[0]!.cwd!), false);
    assert.equal(activeProcesses.has('pi-fixture-worker'), false);
    assert.equal(traces.getTraceRun(fixture.events[0]!.runId)?.status, 'error');
    assert.equal(publicEvents.length, 0);
});

test('late Pi acquire rejection cannot clean up a replacement owner with the same generation', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let rejectAcquire!: (reason: Error) => void;
    fixture.acquireGate = new Promise<void>((_resolve, reject) => { rejectAcquire = reject; });
    const scope = 'pi-test-scope';
    const oldRun = spawnAgent('old deferred acquire', opts());
    let barrier: Promise<void> = Promise.resolve();
    try {
        assert.equal(fixture.acquisitions.length, 1, 'old acquire is waiting on the explicit gate');
        const capturedOwner = activeMainProcesses.get(scope);
        assert.ok(capturedOwner);
        const oldTraceId = fixture.events[0]!.runId;
        // Equal generation and equal null process deliberately defeat a
        // generation/PID-only guard; only captured object ownership is enough.
        const replacement = { ...capturedOwner, meta: { ...capturedOwner.meta, requestId: 'replacement-request' } };
        assert.notEqual(replacement, capturedOwner);
        assert.equal(replacement.ownerGeneration, capturedOwner.ownerGeneration);
        assert.equal(replacement.process, capturedOwner.process);
        activeMainProcesses.set(scope, replacement);
        live.beginLiveRun(scope, 'pi');
        live.setLiveRunTraceId(scope, 'tr_replacement_fixture0001');
        live.appendLiveRunText(scope, 'replacement live content');
        const replacementLive = live.getLiveRun(scope);
        armExitSettle(scope);
        let barrierSettled = false;
        barrier = waitForExitSettled(scope).then(() => { barrierSettled = true; });
        await Promise.resolve();
        assert.equal(barrierSettled, false);
        const beforeFailure = fixture.legacy.length;
        rejectAcquire(new Error('old acquire rejected after replacement'));
        const result = await oldRun.promise;
        // Promise callbacks drain without advancing ANY fake timeout. The new
        // barrier cannot appear preserved/settled merely because of a deadline.
        await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.equal(result.code, 1, 'old invocation still resolves its own failure');
        assert.equal(traces.getTraceRun(oldTraceId)?.status, 'error');
        assertCanonicalContext(false);
        assert.deepEqual({
            ownerPreserved: activeMainProcesses.get(scope) === replacement,
            startingPreserved: replacement.starting,
            live: live.getLiveRun(scope),
            barrierSettled,
            cleanupEvents: fixture.legacy.slice(beforeFailure).filter(event =>
                event.type === 'agent_status' || event.type === 'agent_done').map(event => event.type),
        }, {
            ownerPreserved: true, startingPreserved: true, live: replacementLive,
            barrierSettled: false, cleanupEvents: [],
        });
    } finally {
        rejectAcquire(new Error('fixture cleanup'));
        settleExit(scope);
        await barrier;
        await oldRun.promise;
        activeMainProcesses.delete(scope);
        live.clearLiveRun(scope);
        fixture.acquireGate = null;
        context.mock.timers.reset();
    }
});
