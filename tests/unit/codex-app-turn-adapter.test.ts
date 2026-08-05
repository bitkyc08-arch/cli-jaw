import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppClient } from '../../src/agent/codex-app-client.ts';
import {
    extractFromCodexAppEvent,
    listenCodexAppTurnAdapter,
    type CodexAppEventResult,
} from '../../src/agent/codex-app-events.ts';
import {
    interruptCodexRuntime,
    resolveCodexAppProductionLaneScope,
} from '../../src/agent/runtime-pool.ts';

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Role = 'main' | 'employee';

function injectRequest(client: CodexAppClient, handler: RequestHandler): void {
    Object.defineProperty(client, 'request', { value: handler });
}

function createCtx() {
    return {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        thinkingBuf: '',
    };
}

type AdapterSnapshot = {
    trace: string[];
    progress: number;
    normalized: Array<{ method: string; result: CodexAppEventResult | null }>;
    interrupts: string[];
};

async function exerciseLegacyAdapter(options: {
    gateEnabled: boolean;
    role: Role;
    baseline: boolean;
}): Promise<AdapterSnapshot> {
    const client = new CodexAppClient();
    const threadId = `${options.role}-thread`;
    const turnId = `${options.role}-turn`;
    injectRequest(client, async (method) => {
        if (method === 'turn/interrupt') throw new Error(`${options.role}-interrupt-failed`);
        return {};
    });
    client.threadId = threadId;
    client.activeTurnId = turnId;

    const trace: string[] = [];
    let progress = 0;
    const normalized: AdapterSnapshot['normalized'] = [];
    const interrupts: string[] = [];
    const ctx = createCtx();
    const laneScope = resolveCodexAppProductionLaneScope({
        multiplexEnabled: options.gateEnabled,
        employee: options.role === 'employee',
    });
    assert.equal(laneScope, null, `${options.role} gate=${options.gateEnabled} must stay on the legacy lane`);

    const injectNotifications = (phase: 'pre' | 'post') => {
        client['handleLine'](JSON.stringify({
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, delta: `${options.role}-${phase}` },
        }));
        client['handleLine'](JSON.stringify({
            method: 'configWarning',
            params: { message: `${options.role}-${phase}-host` },
        }));
        client['handleLine'](JSON.stringify({
            method: 'future/raw',
            params: { phase, role: options.role },
        }));
    };
    injectNotifications('pre');

    const handlers = {
        onProgress: () => { progress += 1; },
        onRawNotification: (method: string) => { trace.push(method); },
        onEvent: (method: string, result: CodexAppEventResult | null) => {
            normalized.push({ method, result });
        },
        onStderr: () => {},
        onInterruptFailed: (err: Error) => { interrupts.push(err.message); },
    };
    const listener = options.baseline
        ? client.listenTurn({
            onNotification: (method, params) => {
                handlers.onProgress();
                handlers.onRawNotification(method);
                handlers.onEvent(method, extractFromCodexAppEvent(method, params, ctx));
            },
            onStderr: handlers.onStderr,
            onInterruptFailed: handlers.onInterruptFailed,
        })
        : listenCodexAppTurnAdapter(client, options.role === 'main' ? { threadId } : null, laneScope, ctx, handlers);

    injectNotifications('post');
    await assert.rejects(client.interruptTurn(), new RegExp(`${options.role}-interrupt-failed`));
    listener.dispose();
    return { trace, progress, normalized, interrupts };
}

for (const gateEnabled of [false, true]) {
    for (const role of ['main', 'employee'] as const) {
        test(`production ${role} gate=${gateEnabled} is behaviorally identical to the legacy adapter`, async () => {
            const baseline = await exerciseLegacyAdapter({ gateEnabled, role, baseline: true });
            const actual = await exerciseLegacyAdapter({ gateEnabled, role, baseline: false });
            assert.deepEqual(actual, baseline);
            assert.deepEqual(actual.trace, [
                'item/agentMessage/delta', 'configWarning', 'future/raw',
                'item/agentMessage/delta', 'configWarning', 'future/raw',
            ], 'pre-listener handoff and post-listener delivery preserve legacy order');
            assert.equal(actual.progress, 6);
            assert.deepEqual(actual.interrupts, [`${role}-interrupt-failed`]);
        });
    }
}

test('scoped interrupt helper filters by method and current lane owner before completing', async () => {
    const client = new CodexAppClient();
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return {};
    });
    await client.startThread('scope-a', {
        model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false,
    });

    let settled = false;
    const interrupting = interruptCodexRuntime(client, 'scope-a').then(() => { settled = true; });
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    }));
    client.emit('notification:scope-a', 'turn/completed', {
        threadId: 'thread-a', turn: { id: 'turn-other', status: 'completed' },
    }, { threadId: 'thread-a', turnId: 'turn-other' });
    client.emit('notification:scope-a', 'item/agentMessage/delta', {
        threadId: 'thread-a', turnId: 'turn-a', delta: 'not terminal',
    }, { threadId: 'thread-a', turnId: 'turn-a' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'wrong owner and non-terminal methods cannot release the latch');

    client['handleLine'](JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } },
    }));
    await interrupting;
    assert.equal(client.listenerCount('notification:scope-a'), 0);
    assert.equal(client.listenerCount('interrupt-failed:scope-a'), 0);
});

test('scoped turn adapter derives expected identity from lease and lane state, not notification owner', async () => {
    const client = new CodexAppClient();
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        if (method === 'turn/start') return { turn: { id: 'turn-a' } };
        return {};
    });
    await client.startThread('scope-a', {
        model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false,
    });
    await client.startTurn('scope-a', 'hello');
    const ctx = createCtx();
    const trace: string[] = [];
    const events: string[] = [];
    const listener = listenCodexAppTurnAdapter(client, { threadId: 'thread-a' }, 'scope-a', ctx, {
        onProgress: () => {},
        onRawNotification: (method) => { trace.push(method); },
        onEvent: (method) => { events.push(method); },
        onStderr: () => {},
    });

    client.emit('notification:scope-a', 'turn/started', {
        threadId: 'thread-b', turn: { id: 'turn-b' },
    }, { threadId: 'thread-b', turnId: 'turn-b' });

    assert.deepEqual(trace, ['turn/started'], 'raw trace remains lossless before owner filtering');
    assert.deepEqual(events, [], 'a self-consistent but foreign owner cannot reach the normalizer consumer');
    assert.equal(ctx.sessionId, null, 'foreign owner metadata cannot mutate lane context');
    listener.dispose();
});
