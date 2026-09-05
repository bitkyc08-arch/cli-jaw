import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { settings } from '../../src/core/config.ts';
import { createChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { currentSessionScope } from '../../src/core/session-context.ts';
import { broadcast } from '../../src/core/bus.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import { orchestrateAndCollectData } from '../../src/orchestrator/collect.ts';
import { orchestrate, drainPendingReplays } from '../../src/orchestrator/pipeline.ts';
import { claimWorker, finishWorker } from '../../src/orchestrator/worker-registry.ts';
import { t } from '../../src/core/i18n.ts';
import type { spawnAgent } from '../../src/agent/spawn.ts';
import type { RuntimeLivenessIdentity } from '../../src/shared/runtime-contract.ts';

type Options = NonNullable<Parameters<typeof spawnAgent>[1]>;
type Activity = (source: string, identity?: RuntimeLivenessIdentity) => void;
const MINUTE = 60_000;
const originalMulti = settings['multiSession'];
const differentActiveChat = createChatSession('liveness-active-other').id;
test.afterEach(() => { settings['multiSession'] = originalMulti; setActiveChatSession('default'); });

// Only the native-process boundary is faked. Collector, pipeline, ALS and terminal
// publication are real. Physical listener/lease cleanup belongs to spawn's tests.
function nativeIO() {
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<{ text: string; code: number; traceRunId: string;
        runtimeOutcome: { status: 'done'; finalText: string; partialText: string } }>();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let identity!: RuntimeLivenessIdentity;
    let activity: Activity | undefined;
    let captured: ReturnType<typeof currentSessionScope>;
    const onData = () => activity?.('native-runtime', identity);
    return {
        started: started.promise,
        spawn: (_prompt: string, opts: Options) => {
            identity = Object.freeze({ runId: 'native-run', scope: opts.scopeKey!,
                sessionId: opts.chatSessionId!, origin: opts.origin!,
                ...(opts.requestId ? { requestId: opts.requestId } : {}) });
            activity = opts.lifecycle?.onActivity;
            captured = currentSessionScope();
            stdout.on('data', onData);
            stderr.on('data', onData);
            started.resolve();
            return { child: null, promise: completion.promise };
        },
        pulse: (stream: 'stdout' | 'stderr' = 'stdout') => {
            (stream === 'stdout' ? stdout : stderr).write(Buffer.from('opaque native model-only frame'));
        },
        notify: (patch: Record<string, unknown> = {}, source = 'native-runtime') => {
            activity?.(source, { ...identity, ...patch } as RuntimeLivenessIdentity);
        },
        withoutIdentity: () => activity?.('native-runtime'),
        terminal: () => broadcast('agent_done', { ...identity, traceRunId: identity.runId,
            runtimeFinality: 'present', runtimeStatus: 'done', text: '  final only\n' }),
        finish: () => {
            stdout.off('data', onData);
            stderr.off('data', onData);
            stdout.destroy();
            stderr.destroy();
            completion.resolve({ text: '  final only\n', code: 0, traceRunId: identity.runId,
                runtimeOutcome: { status: 'done', finalText: '  final only\n', partialText: 'private partial' } });
        },
        get identity() { return identity; },
        get captured() { return captured; },
    };
}

const placements = [
    { name: 'unscoped-off', enabled: false, meta: {}, expectedScope: 'default', expectedSession: differentActiveChat },
    { name: 'local-on', enabled: true, meta: { chatSessionId: 'local-chat' }, expectedScope: 'local:local-chat', expectedSession: 'local-chat' },
    ...[false, true].map(enabled => ({ name: `mention-watch-${enabled}`, enabled,
        meta: { scope: 'mention-watch:jaw:slack:channel:C1:thread:123', chatSessionId: 'thread-chat' },
        expectedScope: 'mention-watch:jaw:slack:channel:C1:thread:123', expectedSession: 'thread-chat' })),
];

for (const placement of placements) {
    test(`model-only I/O at minute 19 survives minute 20: ${placement.name}`, async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        settings['multiSession'] = { ...originalMulti, enabled: placement.enabled };
        setActiveChatSession(differentActiveChat);
        const io = nativeIO();
        const events: string[] = [];
        const unsubscribe = subscribe(event => { events.push(event.event); });
        const collecting = orchestrateAndCollectData('task', { ...placement.meta, origin: 'heartbeat',
            requestId: 'liveness-request', _skipReplayDrain: true, _spawnAgent: io.spawn }, 'en');
        let settled = false;
        void collecting.then(() => { settled = true; });
        try {
            await io.started;
            assert.deepEqual(io.captured, { scope: placement.expectedScope, chatSessionId: placement.expectedSession });
            assert.equal(io.identity.scope, placement.expectedScope);
            const beforeActivity = events.length;
            context.mock.timers.tick(19 * MINUTE);
            io.pulse('stdout');
            io.pulse('stderr');
            assert.equal(events.length, beforeActivity, 'I/O callback emits no SSE, text, ACK, or queue event');
            context.mock.timers.tick(2 * MINUTE);
            await Promise.resolve();
            assert.equal(settled, false, 'native liveness must renew the 20-minute collector deadline');
            io.terminal();
            io.finish();
            const result = await collecting;
            assert.equal(result.text, 'final only', 'existing pipeline presentation normalization is unchanged');
            assert.equal(result.data['traceRunId'], 'native-run');
            assert.equal(result.data['sessionId'], placement.expectedSession);
            assert.equal(result.data['scope'], placement.expectedScope);
            assert.equal(events.filter(event => event === 'orchestrate_done').length, 1);
            assert.equal(events.filter(event => event === 'agent_done').length, 1);
            const timerSpy = context.mock.method(globalThis, 'setTimeout');
            io.notify();
            assert.equal(timerSpy.mock.callCount(), 0, 'finished collector cannot restart its timer');
        } finally {
            io.finish();
            await collecting;
            unsubscribe();
            context.mock.timers.reset();
        }
    });
}

const foreign = [
    { name: 'foreign scope', patch: { scope: 'other-scope' } },
    { name: 'default inbound', patch: { scope: 'default', sessionId: differentActiveChat, origin: 'slack' } },
    { name: 'foreign session', patch: { sessionId: 'other-chat' } },
    { name: 'foreign request', patch: { requestId: 'other-request' } },
    { name: 'foreign origin', patch: { origin: 'slack' } },
    { name: 'foreign run after latch', patch: { runId: 'other-run' } },
    { name: 'missing scope', patch: { scope: undefined } },
    { name: 'missing session', patch: { sessionId: undefined } },
    { name: 'missing request', patch: { requestId: undefined } },
    { name: 'missing origin', patch: { origin: undefined } },
    { name: 'missing run', patch: { runId: undefined } },
    { name: 'empty run', patch: { runId: ' ' } },
    { name: 'invalid request type', patch: { requestId: 17 } },
    { name: 'legacy source', patch: {}, source: 'stdout' },
];
for (const scenario of foreign) {
    test(`minute-19 ${scenario.name} cannot extend mention-watch collector`, async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        settings['multiSession'] = { ...originalMulti, enabled: false };
        setActiveChatSession(differentActiveChat);
        const io = nativeIO();
        const collecting = orchestrateAndCollectData('task', { origin: 'heartbeat', requestId: 'liveness-request',
            scope: 'mention-watch:remote', chatSessionId: 'thread-chat', _skipReplayDrain: true,
            _spawnAgent: io.spawn }, 'en');
        try {
            await io.started;
            io.pulse(); // Captures native-run; later same-binding foreign runs are stale.
            context.mock.timers.tick(19 * MINUTE);
            assert.doesNotThrow(() => io.notify(scenario.patch, scenario.source));
            context.mock.timers.tick(MINUTE);
            const result = await collecting;
            assert.deepEqual(result, { text: t('tg.timeout', {}, 'en'), data: {} });
            const timerSpy = context.mock.method(globalThis, 'setTimeout');
            io.notify();
            assert.equal(timerSpy.mock.callCount(), 0, 'timed-out collector cannot revive');
        } finally {
            io.finish();
            await collecting;
            context.mock.timers.reset();
        }
    });
}

test('native agent terminal disposes I/O activity before later pipeline completion', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const io = nativeIO();
    const collecting = orchestrateAndCollectData('task', { origin: 'heartbeat', scope: 'terminal-scope',
        chatSessionId: 'terminal-chat', requestId: 'terminal-request', _skipReplayDrain: true, _spawnAgent: io.spawn }, 'en');
    try {
        await io.started;
        io.pulse();
        io.terminal();
        context.mock.timers.tick(19 * MINUTE);
        io.pulse();
        context.mock.timers.tick(MINUTE);
        assert.deepEqual(await collecting, { text: t('tg.timeout', {}, 'en'), data: {} });
    } finally {
        io.finish();
        await collecting;
        context.mock.timers.reset();
    }
});

test('pipeline catches observer throws and forwards only valid native-runtime identities', async () => {
    let calls = 0;
    const io = nativeIO();
    const running = orchestrate('task', { origin: 'heartbeat', scope: 'observer', chatSessionId: 'observer-chat',
        _skipReplayDrain: true, _spawnAgent: io.spawn,
        _onRuntimeActivity: () => { calls++; throw new Error('observer failed'); } });
    await io.started;
    try {
        assert.doesNotThrow(() => io.pulse());
        assert.equal(calls, 1);
        io.notify({}, 'acp');
        io.notify({ runId: null });
        io.notify({ sessionId: '' });
        io.withoutIdentity();
        assert.equal(calls, 1);
    } finally { io.finish(); await running; }
});

test('default origin and absent request are normalized; unrelated first activity cannot latch', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    settings['multiSession'] = { ...originalMulti, enabled: false };
    setActiveChatSession(differentActiveChat);
    const io = nativeIO();
    const collecting = orchestrateAndCollectData('task', { _skipReplayDrain: true, _spawnAgent: io.spawn }, 'en');
    try {
        await io.started;
        assert.deepEqual(io.identity, { runId: 'native-run', scope: 'default',
            sessionId: differentActiveChat, origin: 'web' });
        broadcast('agent_done', { error: true, text: 'FOREIGN_LEGACY_DIAGNOSTIC' });
        io.notify({ scope: 'foreign', runId: 'foreign-run' });
        context.mock.timers.tick(19 * MINUTE);
        io.pulse();
        context.mock.timers.tick(2 * MINUTE);
        let settled = false;
        void collecting.then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false, 'the unrelated first signal must not latch the foreign run');
        context.mock.timers.tick(18 * MINUTE);
        assert.deepEqual(await collecting, { text: t('tg.timeout', {}, 'en'), data: {} },
            'native I/O marks nativeSeen without any native terminal or canonical event');
    } finally { io.finish(); await collecting; context.mock.timers.reset(); }
});

test('actual worker replay drain never forwards the original collector activity hook', async () => {
    let calls = 0;
    let replayed = 0;
    claimWorker({ id: 'liveness-worker', name: 'worker' }, 'task', {
        origin: 'heartbeat', scopeId: 'worker-scope', chatSessionId: 'worker-chat',
    });
    finishWorker('liveness-worker', 'worker result');
    await drainPendingReplays('worker-scope', {
        _onRuntimeActivity: () => { calls++; },
        _spawnAgent: (_prompt: string, opts: Options) => {
            replayed++;
            assert.equal(opts.lifecycle, undefined);
            assert.equal(opts.scopeKey, 'worker-scope');
            return { child: null, promise: Promise.resolve({ text: 'replayed', code: 0 }) };
        },
    });
    assert.equal(replayed, 1);
    assert.equal(calls, 0);
});
