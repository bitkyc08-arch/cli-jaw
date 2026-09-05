import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionBinding } from '../../src/orchestrator/scope.ts';
import { settings } from '../../src/core/config.ts';
import { createChatSession, getActiveChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { currentSessionScope, withSessionScope } from '../../src/core/session-context.ts';
import { orchestrateAndCollectData } from '../../src/orchestrator/collect.ts';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import type { spawnAgent } from '../../src/agent/spawn.ts';

const originalMulti = settings['multiSession'];
const active = createChatSession('binding-active').id;
const laterActive = createChatSession('binding-later').id;
test.afterEach(() => { settings['multiSession'] = originalMulti; setActiveChatSession('default'); });

const pipelinePlacements = [
    { name: 'forged persisted hint', meta: { chatSessionId: 'pipeline-chat', persistedScopeId: 'jaw:slack:channel:forged' },
        expected: { scope: 'local:pipeline-chat', chatSessionId: 'pipeline-chat' } },
    { name: 'stale persisted hint', meta: { chatSessionId: 'pipeline-chat', persistedScopeId: 'local:previous-chat' },
        expected: { scope: 'local:pipeline-chat', chatSessionId: 'pipeline-chat' } },
    { name: 'remote key', meta: { chatSessionId: 'pipeline-chat', remoteKey: 'jaw:slack:channel:owned', persistedScopeId: 'stale' },
        expected: { scope: 'jaw:slack:channel:owned', chatSessionId: 'pipeline-chat' } },
    { name: 'explicit scope', meta: { scope: 'explicit-pipeline', chatSessionId: 'pipeline-chat', persistedScopeId: 'stale' },
        expected: { scope: 'explicit-pipeline', chatSessionId: 'pipeline-chat' } },
    { name: 'captured scope', meta: { persistedScopeId: 'stale' },
        captured: { scope: 'captured-pipeline', chatSessionId: 'captured-chat' },
        expected: { scope: 'captured-pipeline', chatSessionId: 'captured-chat' } },
];
for (const placement of pipelinePlacements) {
    test(`direct pipeline uses owned placement for ${placement.name}`, { timeout: 5000 }, async t => {
        settings['multiSession'] = { ...originalMulti, enabled: true };
        const network = t.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected pipeline network request'));
        t.mock.method(console, 'log', () => {});
        let calls = 0;
        const meta = { origin: 'heartbeat', requestId: `pipeline-${placement.name}`, _skipReplayDrain: true,
            ...placement.meta,
            _spawnAgent: (_prompt: string, opts: NonNullable<Parameters<typeof spawnAgent>[1]>) => {
                calls++;
                assert.deepEqual({ scope: opts.scopeKey, chatSessionId: opts.chatSessionId }, placement.expected);
                assert.deepEqual(currentSessionScope(), placement.expected);
                return { child: null, promise: Promise.resolve({ text: 'answer', code: 0, traceRunId: 'pipeline-binding',
                    runtimeOutcome: { status: 'done', finalText: 'answer', partialText: '' } }) };
            },
        };
        const invoke = () => orchestrate('text-only fixture', meta);
        if ('captured' in placement && placement.captured) await withSessionScope(placement.captured, invoke);
        else { assert.equal(currentSessionScope(), undefined); await invoke(); }
        assert.equal(calls, 1);
        assert.equal(network.mock.callCount(), 0);
    });
}

test('binding precedence is explicit, captured, then existing gated scope and active chat', () => {
    const base = { activeChatSessionId: 'active-chat', multiSessionEnabled: true,
        captured: { scope: 'captured-scope', chatSessionId: 'captured-chat' },
        persistedScopeId: 'persisted-fallback' };
    const binding = resolveExecutionBinding({ ...base, scope: 'explicit-scope', chatSessionId: 'explicit-chat' });
    assert.deepEqual(binding, { scope: 'explicit-scope', chatSessionId: 'explicit-chat' });
    assert.equal(Object.isFrozen(binding), true);
    assert.deepEqual(resolveExecutionBinding(base), base.captured);
    assert.deepEqual(resolveExecutionBinding({ ...base, captured: null }), {
        scope: 'persisted-fallback', chatSessionId: 'active-chat',
    });
    assert.deepEqual(resolveExecutionBinding({ activeChatSessionId: 'active-chat', multiSessionEnabled: true }), {
        scope: 'default', chatSessionId: 'active-chat',
    });
    assert.deepEqual(resolveExecutionBinding({ activeChatSessionId: 'active-chat', multiSessionEnabled: false,
        persistedScopeId: 'ignored-by-gate' }), { scope: 'default', chatSessionId: 'active-chat' });
    assert.deepEqual(resolveExecutionBinding({ activeChatSessionId: 'active-chat', multiSessionEnabled: true,
        chatSessionId: 'local-chat' }), { scope: 'local:local-chat', chatSessionId: 'local-chat' });
});

test('binding keeps independent explicit overrides and empty-string fallback without coercion', () => {
    const captured = { scope: 'captured-scope', chatSessionId: 'captured-chat' };
    const base = { captured, activeChatSessionId: 'active-chat', multiSessionEnabled: false };
    assert.deepEqual(resolveExecutionBinding({ ...base, scope: 'explicit' }), { scope: 'explicit', chatSessionId: 'captured-chat' });
    assert.deepEqual(resolveExecutionBinding({ ...base, chatSessionId: 'explicit' }), { scope: 'captured-scope', chatSessionId: 'explicit' });
    assert.deepEqual(resolveExecutionBinding({ ...base, scope: '', chatSessionId: '' }), captured);
    assert.deepEqual(resolveExecutionBinding({ activeChatSessionId: '', scope: '', chatSessionId: '' }), {
        scope: 'default', chatSessionId: 'default',
    });
    const frozen = resolveExecutionBinding(base);
    captured.scope = 'changed';
    captured.chatSessionId = 'changed';
    assert.deepEqual(frozen, { scope: 'captured-scope', chatSessionId: 'captured-chat' });
});

for (const key of ['scope', 'chatSessionId'] as const) {
    for (const value of [null, false, 0, 1, {}, []]) {
        test(`binding rejects invalid explicit ${key}: ${JSON.stringify(value)}`, () => {
            // Exercise the actual untyped orchestration ingress, not a valid typed caller.
            const input = { activeChatSessionId: 'active', [key]: value };
            assert.throws(() => resolveExecutionBinding(input as Parameters<typeof resolveExecutionBinding>[0]), TypeError);
        });
    }
}

const placements = [
    { name: 'ordinary default', enabled: false, meta: {}, expected: { scope: 'default', chatSessionId: active } },
    { name: 'ordinary multi-on', enabled: true, meta: { chatSessionId: 'local-chat' },
        expected: { scope: 'local:local-chat', chatSessionId: 'local-chat' } },
    ...[false, true].map(enabled => ({ name: `mention-watch multi=${enabled}`, enabled,
        meta: { scope: 'mention-watch:jaw:slack:channel:C1:thread:123', chatSessionId: 'thread-chat' },
        expected: { scope: 'mention-watch:jaw:slack:channel:C1:thread:123', chatSessionId: 'thread-chat' } })),
];

for (const placement of placements) {
    test(`real collector/pipeline preserves ${placement.name} across async settings wait`, async () => {
        settings['multiSession'] = { ...originalMulti, enabled: placement.enabled };
        setActiveChatSession(active);
        const wait = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        let observed: ReturnType<typeof currentSessionScope>;
        let reentered: ReturnType<typeof resolveExecutionBinding> | undefined;
        const meta = { origin: 'heartbeat', requestId: `binding-${placement.name}`, ...placement.meta,
            _spawnAgent: (_prompt: string, opts: NonNullable<Parameters<typeof spawnAgent>[1]>) => {
                assert.equal(opts.scopeKey, placement.expected.scope);
                assert.equal(opts.chatSessionId, placement.expected.chatSessionId);
                observed = currentSessionScope();
                entered.resolve();
                return { child: null, promise: (async () => {
                    await wait.promise;
                    // Same arguments as the owned spawn settings-wait re-entry.
                    reentered = resolveExecutionBinding({ scope: opts.scopeKey, chatSessionId: opts.chatSessionId,
                        captured: currentSessionScope(), activeChatSessionId: getActiveChatSession(),
                        multiSessionEnabled: settings['multiSession']?.enabled === true });
                    return { text: '  final answer\n', code: 0, traceRunId: 'binding-run',
                        runtimeOutcome: { status: 'done', finalText: '  final answer\n', partialText: 'private' } };
                })() };
            },
        };
        const collecting = orchestrateAndCollectData('task', meta, 'en');
        // Pipeline itself awaits replay draining before spawn: capture precedes that await too.
        setActiveChatSession(laterActive);
        settings['multiSession'] = { ...originalMulti, enabled: !placement.enabled };
        await entered.promise;
        assert.deepEqual(observed, placement.expected);
        assert.equal('_onRuntimeActivity' in meta, false, 'caller metadata is not mutated');
        meta.requestId = 'mutated-after-capture';
        meta.origin = 'slack';
        wait.resolve();
        const result = await collecting;
        assert.deepEqual(reentered, placement.expected);
        assert.equal(result.text, 'final answer', 'existing pipeline presentation normalization is unchanged');
        assert.equal(result.data['scope'], placement.expected.scope);
        assert.equal(result.data['sessionId'], placement.expected.chatSessionId);
        assert.equal('_onRuntimeActivity' in result.data, false);
    });
}

test('invalid explicit placement also rejects at collector ingress instead of defaulting', async () => {
    await assert.rejects(orchestrateAndCollectData('task', { scope: 0 }), TypeError);
    await assert.rejects(orchestrateAndCollectData('task', { chatSessionId: null }), TypeError);
});

for (const enabled of [false, true]) {
    test(`captured ALS placement reaches actual collector/pipeline with gate=${enabled}`, async () => {
        settings['multiSession'] = { ...originalMulti, enabled };
        setActiveChatSession(active);
        const captured = { scope: 'captured:dedicated', chatSessionId: 'captured-thread' };
        const result = await withSessionScope(captured, () => orchestrateAndCollectData('task', {
            origin: 'heartbeat', requestId: 'captured-request', _skipReplayDrain: true,
            _spawnAgent: (_prompt: string, opts: NonNullable<Parameters<typeof spawnAgent>[1]>) => {
                assert.deepEqual(currentSessionScope(), captured);
                assert.equal(opts.scopeKey, captured.scope);
                assert.equal(opts.chatSessionId, captured.chatSessionId);
                return { child: null, promise: Promise.resolve({ text: 'answer', code: 0,
                    runtimeOutcome: { status: 'done', finalText: 'answer', partialText: '' } }) };
            },
        }, 'en'));
        assert.equal(result.text, 'answer');
        assert.equal(result.data['sessionId'], captured.chatSessionId);
    });
}
