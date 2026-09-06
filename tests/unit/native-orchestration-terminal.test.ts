import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { addBroadcastListener, removeBroadcastListener, broadcast } from '../../src/core/bus.ts';
import { orchestrate, orchestrateContinue } from '../../src/orchestrator/pipeline.ts';
import { orchestrateAndCollectData } from '../../src/orchestrator/collect.ts';
import { admitRequest, settleOnce, resetRequestRegistryForTest } from '../../src/orchestrator/request-registry.ts';
import { t } from '../../src/core/i18n.ts';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';

type Payload = Record<string, unknown>;
const identity = { requestId: 'native-terminal', scope: 'native-terminal-scope', chatSessionId: 'default', origin: 'slack' };
const wireIdentity = { requestId: identity.requestId, scope: identity.scope, sessionId: identity.chatSessionId, origin: identity.origin };
const nativeTags = { runtimeFinality: 'absent', runtimeStatus: 'error' };
const capture: Array<{ type: string; data: Payload }> = [];
const listener = (type: string, data: Payload) => { capture.push({ type, data }); };
// Foreign/missing-identity events must originate outside the fake spawn's own
// ALS scope; otherwise broadcast legitimately stamps that scope onto them.
const foreignSource = new AsyncResource('native-terminal-test-source');
const emitOutsideRun = (type: string, data: Payload) => foreignSource.runInAsyncScope(broadcast, undefined, type, data);
test.after(() => { foreignSource.emitDestroy(); });
test.beforeEach(() => { capture.length = 0; resetRequestRegistryForTest(); addBroadcastListener(listener); });
test.afterEach(() => { removeBroadcastListener(listener); resetRequestRegistryForTest(); });

function options(result: { text: string; code: number; runtimeOutcome?: RuntimeTurnOutcome; traceRunId?: unknown }, beforeResult?: () => void) {
    return { ...identity, _skipInsert: true, _skipReplayDrain: true,
        _spawnAgent: () => {
            beforeResult?.();
            return { child: null, promise: Promise.resolve(result) };
        },
    };
}
function event(type: string): Payload {
    const found = capture.find(entry => entry.type === type);
    assert.ok(found, `${type} must be published`);
    return found.data;
}

for (const status of ['done', 'error', 'stopped'] as const) {
for (const finalText of [null, '', ' \n\t']) {
    test(`pipeline preserves ${status} native meaning without leaking partial for ${JSON.stringify(finalText)}`, async () => {
        const outcome: RuntimeTurnOutcome = { status, finalText, partialText: 'PRIVATE_PARTIAL_CANARY' };
        admitRequest(identity.requestId, identity.scope);
        await orchestrate('native task', options({ text: 'PRIVATE_PARTIAL_CANARY', code: 0, runtimeOutcome: outcome }));
        for (const type of ['orchestrate_done', 'request_settled']) {
            const payload = event(type);
            assert.equal(payload['text'], '');
            assert.equal(payload['runtimeFinality'], finalText === null ? 'absent' : 'present');
            assert.equal(payload['runtimeStatus'], status);
            assert.equal(payload['scope'], identity.scope);
            assert.equal(payload['sessionId'], identity.chatSessionId);
            assert.equal('runtimeOutcome' in payload, false);
            assert.equal('partialText' in payload, false);
            assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_PARTIAL_CANARY/);
            const expectedTags = { runtimeFinality: finalText === null ? 'absent' : 'present', runtimeStatus: status };
            assert.deepEqual(JSON.parse(JSON.stringify(payload)), type === 'orchestrate_done'
                ? { ...wireIdentity, text: '', replyViaTarget: false, ...expectedTags }
                : { requestId: identity.requestId, outcome: 'completed', scope: identity.scope,
                    sessionId: identity.chatSessionId, text: '', ...expectedTags });
        }
        assert.equal(outcome.finalText, finalText, 'compatibility normalization must not mutate outcome');
        assert.equal(outcome.partialText, 'PRIVATE_PARTIAL_CANARY');
        assert.equal(capture.filter(entry => entry.type === 'request_settled').length, 1);
    });
}
}

test('real pipeline transforms delivery text while carrying present/error and preserving raw outcome', async () => {
    const raw = 'answer\n<interview_tracker>{"secret":"tracker"}</interview_tracker>';
    const outcome: RuntimeTurnOutcome = { status: 'error', finalText: raw, partialText: 'private' };
    admitRequest(identity.requestId, identity.scope);
    const result = await orchestrateAndCollectData('native task', options({ text: raw, code: 1, runtimeOutcome: outcome }), 'en');
    assert.equal(result.text, 'answer');
    assert.equal(result.data['runtimeFinality'], 'present');
    assert.equal(result.data['runtimeStatus'], 'error');
    assert.equal(outcome.finalText, raw);
    assert.equal(event('request_settled')['text'], 'answer');
});

test('synthetic continue stays untagged without invoking fake spawn', async () => {
    admitRequest(identity.requestId, identity.scope);
    await orchestrateContinue({ ...identity });
    for (const type of ['orchestrate_done', 'request_settled']) {
        const payload = event(type);
        assert.equal(payload['text'], 'No pending work to continue.');
        assert.equal('runtimeFinality' in payload, false);
        assert.equal('runtimeStatus' in payload, false);
    }
});

test('untagged print pipeline retains existing text and omits native tags', async () => {
    await orchestrate('print task', options({ text: 'legacy final', code: 0, traceRunId: 'legacy-private-id' }));
    const payload = event('orchestrate_done');
    assert.equal(payload['text'], 'legacy final');
    assert.equal('runtimeFinality' in payload, false);
    assert.equal('runtimeStatus' in payload, false);
    assert.equal('traceRunId' in payload, false);
});

test('normal native pipeline carries the lifecycle traceRunId on its second terminal', async () => {
    const runId = 'tr_native_terminal_same_identity';
    await orchestrate('native task', options({ text: 'answer', code: 0, traceRunId: runId,
        runtimeOutcome: { status: 'done', finalText: 'answer', partialText: 'PRIVATE_PARTIAL' },
    }, () => {
        emitOutsideRun('agent_done', { ...wireIdentity, text: 'answer', traceRunId: runId,
            runtimeFinality: 'present', runtimeStatus: 'done' });
    }));
    const terminals = capture.filter(entry => entry.type === 'agent_done' || entry.type === 'orchestrate_done');
    assert.deepEqual(terminals.map(entry => [entry.type, entry.data['traceRunId']]), [
        ['agent_done', runId], ['orchestrate_done', runId],
    ]);
    assert.doesNotMatch(JSON.stringify(event('orchestrate_done')), /runtimeOutcome|partialText|PRIVATE_PARTIAL/);
});

for (const traceRunId of [undefined, null, '', ' \t', 17, { id: 'not-a-string' }]) {
    test(`native pipeline omits invalid optional traceRunId ${JSON.stringify(traceRunId)}`, async () => {
        await orchestrate('native task', options({ text: 'answer', code: 0, traceRunId,
            runtimeOutcome: { status: 'done', finalText: 'answer', partialText: '' },
        }));
        assert.equal('traceRunId' in event('orchestrate_done'), false);
        assert.equal(event('orchestrate_done')['runtimeFinality'], 'present');
    });
}

test('collector rejects foreign/missing native identity before listener cleanup', async () => {
    const result = await orchestrateAndCollectData('native task', options({
        text: 'own final', code: 0, runtimeOutcome: { status: 'done', finalText: 'own final', partialText: '' },
    }, () => {
        for (const patch of [{ requestId: 'foreign' }, { requestId: undefined },
            { sessionId: 'foreign' }, { sessionId: undefined }, { scope: 'foreign' }, { scope: undefined }]) {
            emitOutsideRun('orchestrate_done', { ...wireIdentity, ...nativeTags, ...patch, text: 'FOREIGN_TERMINAL' });
        }
    }), 'en');
    assert.equal(result.text, 'own final', 'the matching real pipeline completion must still reach the listener');
    assert.equal(result.data['runtimeStatus'], 'done');
});

for (const patch of [
    { requestId: 'foreign' }, { requestId: undefined }, { scope: 'foreign' }, { scope: undefined },
    { sessionId: 'foreign' }, { sessionId: undefined }, { errorKind: undefined }, { errorKind: 'invented' },
    { audience: 'internal' }, { isEmployee: true }, { origin: 'discord' },
]) {
    test(`native no-response ignores non-own/non-classified diagnostic ${JSON.stringify(patch)}`, async () => {
        const result = await orchestrateAndCollectData('native task', options({ text: '', code: 1,
            runtimeOutcome: { status: 'error', finalText: null, partialText: 'private' },
        }, () => {
            emitOutsideRun('agent_done', { ...wireIdentity, error: true, errorKind: 'exit', text: 'FOREIGN_DIAGNOSTIC', ...patch });
        }), 'en');
        assert.equal(result.text, t('tg.noResponse', {}, 'en'));
        assert.equal(result.data['text'], '', 'diagnostic delivery text is not the canonical/model final');
        assert.equal(result.data['runtimeFinality'], 'absent');
    });
}

test('native no-response uses strictly own classified diagnostic, not an earlier foreign error', async () => {
    const result = await orchestrateAndCollectData('native task', options({ text: '', code: 1,
        runtimeOutcome: { status: 'error', finalText: null, partialText: 'private' },
    }, () => {
        emitOutsideRun('agent_done', { error: true, text: 'FOREIGN_UNSCOPED' });
        emitOutsideRun('agent_done', { ...wireIdentity, error: true, errorKind: 'connection', text: 'Own connection diagnostic' });
    }), 'en');
    assert.equal(result.text, 'Own connection diagnostic');
    assert.equal(result.data['runtimeFinality'], 'absent');
    assert.equal(result.data['text'], '');
});

test('legacy collector retains its existing untagged error fallback', async () => {
    const result = await orchestrateAndCollectData('legacy task', options({ text: '', code: 1 }, () => {
        broadcast('agent_done', { error: true, text: 'legacy collected error' });
    }), 'en');
    assert.equal(result.text, 'legacy collected error');
    assert.equal('runtimeFinality' in result.data, false);
});

test('settlement publishes only exact native tags once and ignores arbitrary private detail fields', () => {
    admitRequest('settled', identity.scope);
    const details = { text: '', runtimeFinality: 'present' as const, runtimeStatus: 'done' as const,
        runtimeOutcome: { status: 'done', finalText: '', partialText: 'PRIVATE' }, partialText: 'PRIVATE' };
    assert.equal(settleOnce('settled', 'completed', details), true);
    assert.equal(settleOnce('settled', 'completed', details), false);
    const payload = event('request_settled');
    assert.equal(payload['runtimeFinality'], 'present');
    assert.equal(payload['runtimeStatus'], 'done');
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|partialText|runtimeOutcome/);
});

for (const finalText of ['', ' \n\t']) {
    test(`native ${JSON.stringify(finalText)} gets existing direct noResponse but queued completion remains empty`, async () => {
        const result = await orchestrateAndCollectData('native task', {
            ...options({ text: finalText, code: 0, runtimeOutcome: { status: 'done', finalText, partialText: 'not final' } }),
            _fromQueue: true, replyViaTarget: true, target: { channel: 'slack', targetId: 'C-test' },
        }, 'en');
        assert.equal(result.text, t('tg.noResponse', {}, 'en'));
        assert.equal(result.data['text'], '');
        assert.equal(result.data['fromQueue'], true);
        assert.equal(result.data['replyViaTarget'], true);
        assert.deepEqual(result.data['target'], { channel: 'slack', targetId: 'C-test' });
        assert.equal(result.data['runtimeFinality'], 'present');
        assert.equal(result.data['runtimeStatus'], 'done');
    });
}

test('concurrent real pipelines keep native diagnostics attached to their own collector', async () => {
    const second = { ...identity, requestId: 'second-request', scope: 'second-scope', chatSessionId: 'second-session' };
    let releaseFirst!: (value: { text: string; code: number; runtimeOutcome: RuntimeTurnOutcome }) => void;
    let releaseSecond!: (value: { text: string; code: number; runtimeOutcome: RuntimeTurnOutcome }) => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const startedFirst = new Promise<void>(resolve => { firstStarted = resolve; });
    const startedSecond = new Promise<void>(resolve => { secondStarted = resolve; });
    const first = orchestrateAndCollectData('first', { ...identity, _skipInsert: true, _skipReplayDrain: true,
        _spawnAgent: () => ({ child: null, promise: new Promise(resolve => { releaseFirst = resolve; firstStarted(); }) }),
    }, 'en');
    const other = orchestrateAndCollectData('second', { ...second, _skipInsert: true, _skipReplayDrain: true,
        _spawnAgent: () => ({ child: null, promise: new Promise(resolve => { releaseSecond = resolve; secondStarted(); }) }),
    }, 'en');
    await Promise.all([startedFirst, startedSecond]);
    emitOutsideRun('agent_done', { ...wireIdentity, error: true, errorKind: 'stall', text: 'First diagnostic' });
    emitOutsideRun('agent_done', { ...wireIdentity, requestId: second.requestId, scope: second.scope,
        sessionId: second.chatSessionId, error: true, errorKind: 'auth', text: 'Second diagnostic' });
    releaseSecond({ text: '', code: 1, runtimeOutcome: { status: 'error', finalText: null, partialText: 'second private' } });
    releaseFirst({ text: '', code: 1, runtimeOutcome: { status: 'stopped', finalText: null, partialText: 'first private' } });
    const [a, b] = await Promise.all([first, other]);
    assert.equal(a.text, 'First diagnostic');
    assert.equal(b.text, 'Second diagnostic');
    assert.equal(a.data['runtimeStatus'], 'stopped');
    assert.equal(b.data['runtimeStatus'], 'error');
});

test('native collector keeps original nonempty final bytes, including surrounding whitespace', async () => {
    const text = '  answer\n';
    const result = await orchestrateAndCollectData('task', options({ text, code: 0,
        runtimeOutcome: { status: 'done', finalText: text, partialText: '' },
    }, () => {
        queueMicrotask(() => emitOutsideRun('orchestrate_done', {
            ...wireIdentity, runtimeFinality: 'present', runtimeStatus: 'done', text,
        }));
    }), 'en');
    assert.equal(result.text, '  answer\n');
    assert.equal(result.data['text'], '  answer\n');
    assert.equal(result.data['runtimeFinality'], 'present');
    assert.equal(result.data['runtimeStatus'], 'done');
});

test('malformed or half-native tags keep original untagged collector fallback', async () => {
    for (const tags of [{ runtimeFinality: 'absent', runtimeStatus: 'running' },
        { runtimeFinality: 'unknown', runtimeStatus: 'done' }, { runtimeFinality: 'absent' }]) {
        const result = await orchestrateAndCollectData('legacy', options({ text: '', code: 0 }, () => {
            queueMicrotask(() => {
                emitOutsideRun('agent_done', { error: true, text: 'legacy diagnostic' });
                emitOutsideRun('orchestrate_done', { ...wireIdentity, ...tags, text: '' });
            });
        }), 'en');
        assert.equal(result.text, 'legacy diagnostic');
    }
});

for (const scenario of [
    { name: 'native timeout excludes foreign collected error', native: true, diagnostic: '' },
    { name: 'native timeout may retain only own classified diagnostic', native: true, diagnostic: 'Own timeout diagnostic' },
    { name: 'legacy timeout keeps original collected fallback', native: false, diagnostic: '' },
]) {
    test(scenario.name, async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        let started!: () => void;
        let release!: (value: { text: string; code: number; runtimeOutcome: RuntimeTurnOutcome }) => void;
        const spawnStarted = new Promise<void>(resolve => { started = resolve; });
        const deferred = new Promise<{ text: string; code: number; runtimeOutcome: RuntimeTurnOutcome }>(resolve => { release = resolve; });
        const collecting = orchestrateAndCollectData('timeout task', {
            ...identity, _skipInsert: true, _skipReplayDrain: true,
            _spawnAgent: () => { started(); return { child: null, promise: deferred }; },
        }, 'en');
        try {
            await spawnStarted;
            emitOutsideRun('agent_done', { error: true, text: 'FOREIGN_COLLECTED_ERROR' });
            if (scenario.native) {
                emitOutsideRun('agent_done', { ...wireIdentity, ...nativeTags, text: '' });
                if (scenario.diagnostic) emitOutsideRun('agent_done', {
                    ...wireIdentity, ...nativeTags, error: true, errorKind: 'stall', text: scenario.diagnostic,
                });
            }
            let settled = false;
            void collecting.then(() => { settled = true; });
            context.mock.timers.tick(1_199_999);
            await Promise.resolve();
            assert.equal(settled, false);
            // Wrong session/scope must not renew the idle deadline or poison
            // the selected diagnostic, even when the request ID matches.
            emitOutsideRun('agent_done', { ...wireIdentity, ...nativeTags,
                scope: 'foreign-scope', sessionId: 'foreign-session',
                error: true, errorKind: 'auth', text: 'FOREIGN_LATE_ERROR' });
            context.mock.timers.tick(1);
            await Promise.resolve();
            assert.equal(settled, true, 'matching timeout must survive a foreign native terminal');
            const result = await collecting;
            assert.deepEqual(result, {
                text: scenario.native ? scenario.diagnostic || t('tg.timeout', {}, 'en') : 'FOREIGN_COLLECTED_ERROR',
                data: {},
            }, 'application timeout must not fabricate runtimeFinality/runtimeStatus or a model final');
            assert.equal(capture.filter(entry => entry.type === 'orchestrate_done').length, 0,
                'timeout does not broadcast an invented orchestration completion');
            let lateReads = 0;
            emitOutsideRun('orchestrate_done', { ...wireIdentity, text: 'late final', runtimeStatus: 'done',
                get runtimeFinality() { lateReads++; return 'present'; },
            });
            assert.equal(lateReads, 0, 'timed-out collector listener must be detached');
        } finally {
            // Release the fake spawn deterministically, allowing the real
            // pipeline to finish without leaving an unresolved test task.
            let completed!: () => void;
            const completion = new Promise<void>(resolve => { completed = resolve; });
            const onComplete = (type: string, data: Payload) => {
                if (type === 'orchestrate_done' && data['requestId'] === identity.requestId) completed();
            };
            addBroadcastListener(onComplete);
            try {
                release({ text: 'cleanup final', code: 0,
                    runtimeOutcome: { status: 'done', finalText: 'cleanup final', partialText: '' } });
                await completion;
                await collecting;
            } finally {
                removeBroadcastListener(onComplete);
                context.mock.timers.reset();
            }
        }
    });
}
