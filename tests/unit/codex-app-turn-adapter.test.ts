import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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

// Getting both ids wrong at once passes even if only one of them is checked, so
// each authority is broken on its own here: the thread comes from the lease and
// the turn from the lane's active state, and neither may be taken from the
// notification being validated.
test('a foreign thread is rejected even when the turn matches the lane', async () => {
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
    const events: string[] = [];
    const listener = listenCodexAppTurnAdapter(client, { threadId: 'thread-a' }, 'scope-a', ctx, {
        onProgress: () => {},
        onRawNotification: () => {},
        onEvent: (method) => { events.push(method); },
        onStderr: () => {},
    });

    // turn-a is genuinely this lane's active turn; only the thread is foreign.
    client.emit('notification:scope-a', 'turn/started', {
        threadId: 'thread-b', turn: { id: 'turn-a' },
    }, { threadId: 'thread-b', turnId: 'turn-a' });

    assert.deepEqual(events, [], 'the lease thread is the authority, not the notification');
    assert.equal(ctx.sessionId, null);
    listener.dispose();
});

test('a stale turn is rejected even when the thread matches the lease', async () => {
    const client = new CodexAppClient();
    let nextTurn = 'turn-a';
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        if (method === 'turn/start') return { turn: { id: nextTurn } };
        return {};
    });
    await client.startThread('scope-a', {
        model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false,
    });
    await client.startTurn('scope-a', 'first');
    client['handleLine'](JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } },
    }));
    nextTurn = 'turn-b';
    await client.startTurn('scope-a', 'second');

    const ctx = createCtx();
    const events: string[] = [];
    const listener = listenCodexAppTurnAdapter(client, { threadId: 'thread-a' }, 'scope-a', ctx, {
        onProgress: () => {},
        onRawNotification: () => {},
        onEvent: (method) => { events.push(method); },
        onStderr: () => {},
    });

    // thread-a is correct; turn-a finished and is no longer the lane's turn.
    client.emit('notification:scope-a', 'item/agentMessage/delta', {
        threadId: 'thread-a', turnId: 'turn-a', delta: 'late',
    }, { threadId: 'thread-a', turnId: 'turn-a' });
    assert.deepEqual(events, [], 'the lane active turn is the authority, not the notification');

    client.emit('notification:scope-a', 'item/agentMessage/delta', {
        threadId: 'thread-a', turnId: 'turn-b', delta: 'live',
    }, { threadId: 'thread-a', turnId: 'turn-b' });
    assert.deepEqual(events, ['item/agentMessage/delta'], 'the current turn still reaches the consumer');
    listener.dispose();
});

// The selector returning null is only half the promise; the other half is that
// production actually routes through it. Running spawnAgent here would mean
// standing up the whole agent stack, so this parses the two call sites instead
// and checks that the scope they hand the adapter is the selector's result -
// not scopeKey, not a literal, not anything else in reach. A regex over the
// file would match the same text in a comment, so the check walks the AST.
test('both production call sites pass the selector result as the lane scope', async () => {
    const ts = await import('typescript');
    const source = await import('node:fs/promises')
        .then((fs) => fs.readFile(resolve(import.meta.dirname, '../../src/agent/spawn.ts'), 'utf8'));
    const sf = ts.createSourceFile('spawn.ts', source, ts.ScriptTarget.Latest, true);

    let selectorBinding: string | null = null;
    const laneArgs: string[] = [];
    const visit = (node: import('typescript').Node): void => {
        if (
            ts.isVariableDeclaration(node)
            && node.initializer
            && ts.isCallExpression(node.initializer)
            && ts.isIdentifier(node.initializer.expression)
            && node.initializer.expression.text === 'resolveCodexAppProductionLaneScope'
            && ts.isIdentifier(node.name)
        ) {
            selectorBinding = node.name.text;
        }
        if (
            ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === 'runCodexAppTurn'
        ) {
            const third = node.arguments[2];
            laneArgs.push(third && ts.isIdentifier(third) ? third.text : '<not-an-identifier>');
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    assert.equal(selectorBinding, 'laneScope', 'the selector result must be bound before use');
    assert.equal(laneArgs.length, 2, 'main and employee are the only production call sites');
    assert.deepEqual(laneArgs, ['laneScope', 'laneScope'],
        'every production call site passes the selector result, so C1 cannot wire a real scope by accident');
});
