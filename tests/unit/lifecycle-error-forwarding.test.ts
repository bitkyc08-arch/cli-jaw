import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentExit, type ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import { createSlackForwarder } from '../../src/slack/forwarder.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';

// #519 round 2: the two stall branches of handleAgentExit emitted error:true
// without errorKind, so the very failure the user most needs to see (a watchdog
// kill after minutes of silence) was the one the Slack/Discord gate dropped.
// This drives the REAL exit handler into the REAL forwarder through the bus.

function stallParams(overrides: Partial<ExitHandlerParams> = {}): ExitHandlerParams {
    return {
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: '', stallReason: 'absolute timeout 2045s' },
        code: 124, cli: 'codex', model: 'test', resumeKey: null, agentLabel: 'Boss', mainManaged: true,
        origin: 'web', prompt: 'test', opts: {}, cfg: {}, ownerGeneration: 1,
        persistenceOwner: { global: 0, scope: 0 }, forceNew: false, empSid: null, isResume: false,
        wasKilled: true, wasSteer: false, smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
        effortDefault: 'medium', costLine: '', resolve: () => {}, activeProcesses: new Map(), scopeKey: 'lef-test',
        chatSessionId: 'lef-test', childProcess: null, releaseMainRun: () => false,
        retryState: { setTimer: () => {}, setResolve: () => {}, setOrigin: () => {}, setIsEmployee: () => {} },
        fallbackState: new Map(), fallbackMaxRetries: 1, processQueue: () => {},
        ...overrides,
    };
}

async function runStall(overrides: Partial<ExitHandlerParams> = {}) {
    const ends: Array<Parameters<NonNullable<ExitHandlerParams['onRuntimeEnd']>>[0]> = [];
    let result: Parameters<ExitHandlerParams['resolve']>[0] | undefined;
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
        fetches++;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const seen: Record<string, unknown>[] = [];
    const capture = (type: string, data: Record<string, unknown>) => { if (type === 'agent_done') seen.push(data); };
    const forward = createSlackForwarder({
        getToken: () => 'xoxb-test',
        getLastTarget: () => ({ channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1' }),
    });
    const pending: Promise<void>[] = [];
    const forwardListener = (type: string, data: Record<string, unknown>) => { pending.push(forward(type, data)); };
    addBroadcastListener(capture);
    addBroadcastListener(forwardListener);
    try {
        await handleAgentExit(stallParams({ ...overrides,
            onRuntimeEnd: end => { ends.push(end); overrides.onRuntimeEnd?.(end); },
            resolve: value => { result = value; overrides.resolve?.(value); },
        }));
        await Promise.all(pending);
        return { payload: seen[0], payloads: seen, fetches, ends, result };
    } finally {
        removeBroadcastListener(capture);
        removeBroadcastListener(forwardListener);
        globalThis.fetch = realFetch;
    }
}

test('LEF-001: a watchdog kill (wasKilled + stallReason) reaches Slack as a classified stall', async () => {
    const { payload, fetches, ends } = await runStall();
    assert.equal(payload?.error, true);
    assert.equal(payload?.errorKind, 'stall', 'the kill branch must carry the classifier kind');
    assert.equal(payload?.cli, 'codex');
    assert.equal(fetches, 1, 'the forwarder gate must let it through');
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.status, 'stopped');
    assert.equal(ends[0]?.finalText, null);
});

for (const finalText of [null, '', ' \n\t ']) {
    test('native empty compatibility terminal closes once without passive Slack send: ' + JSON.stringify(finalText), async () => {
        const { payloads, payload, fetches, ends, result } = await runStall({
            code: 0, wasKilled: false, opts: { _skipSessionPersist: true },
            ctx: { fullText: 'DO NOT DELIVER PARTIAL', liveOutputText: 'DO NOT DELIVER LIVE',
                requestId: 'native-request', sessionId: 'provider-session', toolLog: [], traceLog: [], stderrBuf: '',
                runtimeOutcome: { status: 'done', finalText, partialText: 'DO NOT DELIVER PARTIAL' } },
        });
        assert.equal(payloads.length, 1);
        assert.equal(payload?.['text'], '');
        assert.equal(payload?.['runtimeFinality'], finalText === null ? 'absent' : 'present');
        assert.equal(payload?.['runtimeStatus'], 'done');
        assert.equal(payload?.['requestId'], 'native-request');
        assert.equal(payload?.['sessionId'], 'lef-test');
        assert.equal(payload?.['scope'], 'lef-test');
        assert.equal(fetches, 0, 'passive forwarder only; direct diagnostic producers are outside this test');
        assert.equal(ends[0]?.finalText, finalText);
        assert.equal(result?.runtimeOutcome?.finalText, finalText);
        assert.equal(result?.text, '');
    });
}

test('throwing legacy terminal observer does not duplicate or suppress existing final delivery', async () => {
    const { payload, fetches, ends, result } = await runStall({
        code: 0, wasKilled: false, costLine: '\nCOST', opts: { _skipSessionPersist: true },
        ctx: { fullText: '<think>hidden</think>answer', sessionId: null, toolLog: [], traceLog: [], stderrBuf: '' },
        onRuntimeEnd: () => { throw new Error('projection unavailable'); },
    });
    assert.equal(fetches, 1);
    assert.equal(payload?.['text'], 'answer\nCOST');
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.finalText, 'answer\nCOST');
    assert.equal(result?.runtimeOutcome, undefined);
    assert.equal(result?.text, '<think>hidden</think>answer');
});

test('LEF-002: a non-killed stall exit (isStall branch) is classified the same way', async () => {
    const { payload, fetches } = await runStall({ wasKilled: false, code: 1,
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: 'stall detected', stallReason: 'no output for 900s' } });
    assert.equal(payload?.errorKind, 'stall');
    assert.equal(fetches, 1);
});
