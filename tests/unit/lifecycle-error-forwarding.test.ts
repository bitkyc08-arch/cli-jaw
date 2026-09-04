import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentExit } from '../../src/agent/lifecycle-handler.ts';
import { createSlackForwarder } from '../../src/slack/forwarder.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';

// #519 round 2: the two stall branches of handleAgentExit emitted error:true
// without errorKind, so the very failure the user most needs to see (a watchdog
// kill after minutes of silence) was the one the Slack/Discord gate dropped.
// This drives the REAL exit handler into the REAL forwarder through the bus.

function stallParams(overrides: Record<string, unknown> = {}) {
    return {
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: '', stallReason: 'absolute timeout 2045s' },
        code: 124, cli: 'codex', model: 'test', resumeKey: null, agentLabel: 'Boss', mainManaged: true,
        origin: 'web', prompt: 'test', opts: {}, cfg: {}, ownerGeneration: 1,
        persistenceOwner: { global: 0, scope: 0 }, forceNew: false, empSid: null, isResume: false,
        wasKilled: true, wasSteer: false, smokeResult: { isSmoke: false, confidence: 'low', reason: '' },
        effortDefault: 'medium', costLine: '', resolve: () => {}, activeProcesses: new Map(), scopeKey: 'lef-test',
        chatSessionId: 'lef-test', childProcess: null, releaseMainRun: () => false,
        retryState: { setTimer: () => {}, setResolve: () => {}, setOrigin: () => {}, setIsEmployee: () => {} },
        fallbackState: new Map(), fallbackMaxRetries: 1, processQueue: () => {},
        ...overrides,
    } as never;
}

async function runStall(overrides: Record<string, unknown> = {}) {
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
    addBroadcastListener(capture);
    addBroadcastListener(forward);
    try {
        await handleAgentExit(stallParams(overrides));
        await new Promise((r) => setTimeout(r, 20));
        return { payload: seen[0], fetches };
    } finally {
        removeBroadcastListener(capture);
        removeBroadcastListener(forward);
        globalThis.fetch = realFetch;
    }
}

test('LEF-001: a watchdog kill (wasKilled + stallReason) reaches Slack as a classified stall', async () => {
    const { payload, fetches } = await runStall();
    assert.equal(payload?.error, true);
    assert.equal(payload?.errorKind, 'stall', 'the kill branch must carry the classifier kind');
    assert.equal(payload?.cli, 'codex');
    assert.equal(fetches, 1, 'the forwarder gate must let it through');
});

test('LEF-002: a non-killed stall exit (isStall branch) is classified the same way', async () => {
    const { payload, fetches } = await runStall({ wasKilled: false, code: 1,
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: 'stall detected', stallReason: 'no output for 900s' } });
    assert.equal(payload?.errorKind, 'stall');
    assert.equal(fetches, 1);
});
