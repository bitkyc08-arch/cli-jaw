import test from 'node:test';
import assert from 'node:assert/strict';
import {
    loadCatalogEfforts,
    validateModelEffort,
    type CatalogEfforts,
} from '../../src/agent/codex-app-catalog.ts';
import {
    CodexAppClient,
    isRecoverableResumeError,
} from '../../src/agent/codex-app-client.ts';

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const laneOptions = { model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false };

function injectRequest(client: CodexAppClient, handler: RequestHandler): void {
    Object.defineProperty(client, 'request', { value: handler });
}

test('validateModelEffort fails open without a catalog', () => {
    assert.deepEqual(
        validateModelEffort('gpt-5.5', 'high', new Map()),
        { ok: true, skipped: 'no-catalog' },
    );
});

test('validateModelEffort fails open when the model is not listed', () => {
    const efforts: CatalogEfforts = new Map([['gpt-5.5', new Set(['medium'])]]);
    assert.deepEqual(
        validateModelEffort('other-model', 'high', efforts),
        { ok: true, skipped: 'model-not-listed' },
    );
});

test('validateModelEffort accepts a supported effort', () => {
    const efforts: CatalogEfforts = new Map([['gpt-5.5', new Set(['medium', 'high'])]]);
    assert.deepEqual(validateModelEffort('gpt-5.5', 'high', efforts), { ok: true });
});

test('validateModelEffort rejects an unsupported effort with the supported list', () => {
    const efforts: CatalogEfforts = new Map([['gpt-5.5', new Set(['low', 'medium'])]]);
    assert.deepEqual(
        validateModelEffort('gpt-5.5', 'high', efforts),
        {
            ok: false,
            error: 'effort "high" is not supported by gpt-5.5 (supported: low, medium)',
        },
    );
});

test('validateModelEffort retries a bracket-suffix-stripped slug after exact lookup', () => {
    const fallbackEfforts: CatalogEfforts = new Map([['kimi/k3', new Set(['high'])]]);
    assert.deepEqual(validateModelEffort('kimi/k3[1m]', 'high', fallbackEfforts), { ok: true });

    const exactEfforts: CatalogEfforts = new Map([
        ['kimi/k3[1m]', new Set(['low'])],
        ['kimi/k3', new Set(['high'])],
    ]);
    assert.deepEqual(
        validateModelEffort('kimi/k3[1m]', 'high', exactEfforts),
        {
            ok: false,
            error: 'effort "high" is not supported by kimi/k3[1m] (supported: low)',
        },
    );
});

test('loadCatalogEfforts fails open when the catalog does not exist', () => {
    assert.equal(loadCatalogEfforts('/definitely/missing/codex-model-catalog.json').size, 0);
});

test('isRecoverableResumeError classifies missing-thread wire errors only', () => {
    const liveWireMessage = 'JSON-RPC error -32600: no rollout found for thread id 00000000-0000-0000-0000-000000000000';
    assert.equal(isRecoverableResumeError(liveWireMessage), true);
    assert.equal(isRecoverableResumeError('unknown thread abc'), true);
    assert.equal(isRecoverableResumeError('connect ECONNREFUSED 127.0.0.1:1234'), false);
    assert.equal(isRecoverableResumeError('Process exited'), false);
});

test('listModels follows nextCursor and forwards includeHidden on every page', async () => {
    const client = new CodexAppClient();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (requests.length === 1) return { data: ['first'], nextCursor: 'page-2' };
        return { data: ['second'], nextCursor: null };
    });

    assert.deepEqual(await client.listModels({ includeHidden: true }), ['first', 'second']);
    assert.deepEqual(requests, [
        { method: 'model/list', params: { includeHidden: true } },
        { method: 'model/list', params: { cursor: 'page-2', includeHidden: true } },
    ]);
});

test('interrupt latch sends cancel when turn/started arrives after initialization', async () => {
    const client = new CodexAppClient();
    const scope = 'scope-1';
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        return {};
    });

    await client.startThread(scope, laneOptions);
    requests.length = 0;
    await client.interruptTurn(scope);
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-init' } },
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(requests, [{
        method: 'turn/interrupt',
        params: { threadId: 'thread-1', turnId: 'turn-init' },
    }]);
});

test('interrupt latch sends cancel when requested during turn/start', async () => {
    const client = new CodexAppClient();
    const scope = 'scope-2';
    let resolveStart!: (result: unknown) => void;
    const startResult = new Promise<unknown>((resolve) => { resolveStart = resolve; });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-2' } };
        if (method === 'turn/start') return startResult;
        return {};
    });

    await client.startThread(scope, laneOptions);
    requests.length = 0;
    const starting = client.startTurn(scope, 'hello');
    await client.interruptTurn(scope);
    resolveStart({ turn: { id: 'turn-starting' } });
    await starting;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(requests, [
        {
            method: 'turn/start',
            params: {
                threadId: 'thread-2',
                input: [{ type: 'text', text: 'hello', text_elements: [] }],
                effort: 'medium',
                summary: 'detailed',
            },
        },
        {
            method: 'turn/interrupt',
            params: { threadId: 'thread-2', turnId: 'turn-starting' },
        },
    ]);
});

test('interrupt latch ignores terminal turn races', async () => {
    const client = new CodexAppClient();
    const scope = 'scope-3';
    let failures = 0;
    client.on(`interrupt-failed:${scope}`, () => { failures += 1; });
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-3' } };
        throw new Error('unknown turn turn-terminal');
    });

    await client.startThread(scope, laneOptions);
    await client.interruptTurn(scope);
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-3', turn: { id: 'turn-terminal' } },
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(failures, 0);
});

test('interrupt latch emits interrupt-failed for transport errors', async () => {
    const client = new CodexAppClient();
    const scope = 'scope-4';
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-4' } };
        throw new Error('stdin not writable');
    });
    const failure = new Promise<Error>((resolve) => client.once(`interrupt-failed:${scope}`, resolve));

    await client.startThread(scope, laneOptions);
    await client.interruptTurn(scope);
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-4', turn: { id: 'turn-transport' } },
    }));

    assert.match((await failure).message, /stdin not writable/);
});

test('legacy interrupt failure reaches scoped and global channels exactly once', async () => {
    const client = new CodexAppClient();
    const counts = { scoped: 0, global: 0 };
    injectRequest(client, async (method) => {
        if (method === 'turn/interrupt') throw new Error('transport lost');
        return {};
    });
    client.threadId = 'legacy-thread';
    client.on('interrupt-failed:legacy/default', () => { counts.scoped += 1; });
    client.once('interrupt-failed', () => { counts.global += 1; });

    await client.interruptTurn();
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'legacy-thread', turn: { id: 'legacy-turn' } },
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(counts, { scoped: 1, global: 1 });
});

test('duplicate thread binding rejects without overwriting the first owner', async () => {
    const client = new CodexAppClient();
    injectRequest(client, async () => ({ thread: { id: 'shared-thread' } }));

    await client.resumeThread('scope-a', 'shared-thread', laneOptions);
    await assert.rejects(
        client.resumeThread('scope-b', 'shared-thread', laneOptions),
        /already bound to scope scope-a/,
    );
    assert.equal(client.getThreadId('scope-a'), 'shared-thread');
    assert.equal(client.getThreadId('scope-b'), null);
});

test('each scope keeps independent model, effort, cwd, and fast-mode wire settings', async () => {
    const client = new CodexAppClient();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let nextThread = 0;
    let nextTurn = 0;
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: `thread-${nextThread++}` } };
        return { turn: { id: `turn-${nextTurn++}` } };
    });

    await client.startThread('scope-a', {
        model: 'model-a', effort: 'low', cwd: '/a', fastMode: false, instructions: 'a-only',
    });
    await client.startThread('scope-b', {
        model: 'model-b', effort: 'high', cwd: '/b', fastMode: true,
    });
    await client.startTurn('scope-a', 'a');
    await client.startTurn('scope-b', 'b');

    const starts = requests.filter(({ method }) => method === 'thread/start');
    assert.equal(starts[0]?.params['model'], 'model-a');
    assert.equal(starts[0]?.params['cwd'], '/a');
    assert.equal((starts[0]?.params['config'] as Record<string, unknown>)['service_tier'], 'default');
    assert.equal(starts[0]?.params['developerInstructions'], 'a-only');
    assert.equal(starts[1]?.params['model'], 'model-b');
    assert.equal(starts[1]?.params['cwd'], '/b');
    assert.equal((starts[1]?.params['config'] as Record<string, unknown>)['service_tier'], 'fast');
    assert.equal(Object.hasOwn(starts[1]?.params ?? {}, 'developerInstructions'), false);
    const turns = requests.filter(({ method }) => method === 'turn/start');
    assert.equal(turns[0]?.params['effort'], 'low');
    assert.equal(turns[1]?.params['effort'], 'high');
});

test('rebind clears old indexes and a pending interrupt latch atomically', async () => {
    const client = new CodexAppClient();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let thread = 'thread-old';
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: thread } };
        if (method === 'turn/start') return { turn: { id: 'turn-new' } };
        return {};
    });

    await client.startThread('scope-a', laneOptions);
    await client.interruptTurn('scope-a');
    thread = 'thread-new';
    await client.startThread('scope-a', laneOptions);
    await client.startTurn('scope-a', 'hello');

    assert.equal(client.getThreadId('scope-a'), 'thread-new');
    assert.equal(requests.some(({ method }) => method === 'turn/interrupt'), false);
    const stale: string[] = [];
    client.on('notification:scope-a', (method) => { stale.push(method); });
    client['handleLine'](JSON.stringify({
        method: 'thread/status/changed',
        params: { threadId: 'thread-old' },
    }));
    assert.deepEqual(stale, []);

    // Dropping the old thread from the reverse index is what makes it claimable
    // again, and this has to be checked on the client that did the rebind. A
    // fresh client would pass no matter what the original one left behind.
    thread = 'thread-old';
    await client.startThread('scope-b', laneOptions);
    assert.equal(client.getThreadId('scope-b'), 'thread-old',
        'the rebound scope must have released its previous thread');
    thread = 'thread-new';
    await assert.rejects(client.startThread('scope-c', laneOptions), /already bound/,
        'a thread that is still held stays exclusive');
});

// The thread stays the same across both turns here, so a guard that only
// compares thread identity lets the first turn's trailing output land in the
// second one. That is the case the triple match exists for, and dropping the
// active-turn half of resolveTurnOwner has to fail this.
test('a delta from a finished turn does not reach the turn that replaced it', async () => {
    const client = new CodexAppClient();
    let nextTurn = 'turn-a';
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        if (method === 'turn/start') return { turn: { id: nextTurn } };
        return {};
    });

    const seen: Array<{ method: string; turnId: unknown }> = [];
    client.on('notification:scope-a', (method: string, params: Record<string, unknown>) => {
        seen.push({ method, turnId: params['turnId'] });
    });

    await client.startThread('scope-a', laneOptions);
    await client.startTurn('scope-a', 'first');
    client['handleLine'](JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    }));

    nextTurn = 'turn-b';
    await client.startTurn('scope-a', 'second');
    const beforeStale = seen.length;

    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'late' },
    }));
    assert.equal(seen.length, beforeStale, 'the finished turn must not deliver into its successor');

    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-b', delta: 'live' },
    }));
    assert.deepEqual(seen.at(-1), { method: 'item/agentMessage/delta', turnId: 'turn-b' },
        'the current turn still delivers');
});

// The notification stream and the response race, so a short turn can be over
// before turn/start returns. Rebinding it at that point would make a finished
// turn active again and every later turn would fail against it.
test('a turn that finishes before its response is not resurrected by the late reply', async () => {
    const client = new CodexAppClient();
    let resolveTurn!: (result: unknown) => void;
    const turnResponse = new Promise<unknown>((resolve) => { resolveTurn = resolve; });
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        if (method === 'turn/start') return turnResponse;
        return {};
    });

    const seen: string[] = [];
    client.on('notification:scope-a', (method: string) => { seen.push(method); });

    await client.startThread('scope-a', laneOptions);
    const turning = client.startTurn('scope-a', 'hello');

    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    }));
    client['handleLine'](JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    }));
    resolveTurn({ turn: { id: 'turn-a' } });
    await turning;

    assert.deepEqual(seen, ['turn/started', 'turn/completed']);
    assert.equal(client.getActiveTurnId('scope-a'), null,
        'the completed turn must not be active again');
    await client.closeScope('scope-a');
});

// Ending the first turn through notifications frees the lane, so a second turn
// can be running by the time the first request finally rejects. Cleaning up
// unconditionally in that catch would tear down the turn that is now live.
test('a late failure from a finished turn does not tear down its successor', async () => {
    const client = new CodexAppClient();
    let rejectFirst!: (err: Error) => void;
    const firstResponse = new Promise<unknown>((_, reject) => { rejectFirst = reject; });
    let call = 0;
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        if (method === 'turn/start') {
            call += 1;
            return call === 1 ? firstResponse : { turn: { id: 'turn-2' } };
        }
        return {};
    });

    await client.startThread('scope-a', laneOptions);
    const first = client.startTurn('scope-a', 'first');
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-a', turn: { id: 'turn-1' } },
    }));
    client['handleLine'](JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-1' } },
    }));

    await client.startTurn('scope-a', 'second');
    assert.equal(client.getActiveTurnId('scope-a'), 'turn-2');

    rejectFirst(new Error('late failure'));
    await assert.rejects(first, /late failure/);
    assert.equal(client.getActiveTurnId('scope-a'), 'turn-2',
        'the stale request must not clear the running turn');

    const seen: string[] = [];
    client.on('notification:scope-a', (method: string) => { seen.push(method); });
    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-2', delta: 'live' },
    }));
    assert.deepEqual(seen, ['item/agentMessage/delta'], 'the running turn still delivers');
});

test('thread notification before start response is replayed once after binding', async () => {
    const client = new CodexAppClient();
    let resolveStart!: (result: unknown) => void;
    const response = new Promise<unknown>((resolve) => { resolveStart = resolve; });
    injectRequest(client, async () => response);
    const seen: string[] = [];
    client.listenTurn('scope-a', {
        onNotification: (method) => { seen.push(method); },
        onStderr: () => {},
    });

    const starting = client.startThread('scope-a', laneOptions);
    client['handleLine'](JSON.stringify({
        method: 'thread/started',
        params: { thread: { id: 'thread-a' } },
    }));
    assert.deepEqual(seen, []);
    resolveStart({ thread: { id: 'thread-a' } });
    await starting;
    assert.deepEqual(seen, ['thread/started']);
});

test('thread terminal notification before start response explicitly fails binding', async () => {
    const client = new CodexAppClient();
    let resolveStart!: (result: unknown) => void;
    const response = new Promise<unknown>((resolve) => { resolveStart = resolve; });
    injectRequest(client, async () => response);

    const starting = client.startThread('scope-a', laneOptions);
    client['handleLine'](JSON.stringify({
        method: 'thread/closed',
        params: { threadId: 'thread-a' },
    }));
    resolveStart({ thread: { id: 'thread-a' } });

    await assert.rejects(starting, /Thread thread-a closed during binding/);
    assert.equal(client.getThreadId('scope-a'), null);
});

test('first delta before turn response is buffered then replayed exactly once', async () => {
    const client = new CodexAppClient();
    let resolveTurn!: (result: unknown) => void;
    const turnResponse = new Promise<unknown>((resolve) => { resolveTurn = resolve; });
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        if (method === 'turn/start') return turnResponse;
        return {};
    });
    await client.startThread('scope-a', laneOptions);
    const seen: string[] = [];
    client.on('notification:scope-a', (_method, params) => {
        seen.push(String(params['delta']));
    });

    const starting = client.startTurn('scope-a', 'hello');
    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'first' },
    }));
    assert.deepEqual(seen, []);
    resolveTurn({ turn: { id: 'turn-a' } });
    await starting;
    assert.deepEqual(seen, ['first']);
});

test('first delta remains buffered when turn/started also precedes the response', async () => {
    const client = new CodexAppClient();
    let resolveTurn!: (result: unknown) => void;
    const turnResponse = new Promise<unknown>((resolve) => { resolveTurn = resolve; });
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return turnResponse;
    });
    await client.startThread('scope-a', laneOptions);
    const seen: string[] = [];
    client.on('notification:scope-a', (method, params) => {
        seen.push(method === 'item/agentMessage/delta' ? String(params['delta']) : method);
    });

    const starting = client.startTurn('scope-a', 'hello');
    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'first' },
    }));
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    }));
    resolveTurn({ turn: { id: 'turn-a' } });
    await starting;

    assert.deepEqual(seen, ['first', 'turn/started']);
});

test('turn/started and turn/start response ID conflict fails the lane operation', async () => {
    const client = new CodexAppClient();
    let resolveTurn!: (result: unknown) => void;
    const turnResponse = new Promise<unknown>((resolve) => { resolveTurn = resolve; });
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return turnResponse;
    });
    await client.startThread('scope-a', laneOptions);

    const starting = client.startTurn('scope-a', 'hello');
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-a', turn: { id: 'turn-notification' } },
    }));
    resolveTurn({ turn: { id: 'turn-response' } });

    await assert.rejects(starting, /conflicts with active turn turn-notification/);
    assert.equal(client.getActiveTurnId('scope-a'), null);
});

test('completed old turn deltas cannot enter the next active turn', async () => {
    const client = new CodexAppClient();
    let nextTurn = 'turn-a';
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        if (method === 'turn/start') return { turn: { id: nextTurn } };
        return {};
    });
    await client.startThread('scope-a', laneOptions);
    await client.startTurn('scope-a', 'a');
    client['handleLine'](JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } },
    }));
    nextTurn = 'turn-b';
    await client.startTurn('scope-a', 'b');
    const seen: string[] = [];
    client.on('notification:scope-a', (method) => { seen.push(method); });

    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'late' },
    }));
    assert.deepEqual(seen, []);
    assert.equal(client.getActiveTurnId('scope-a'), 'turn-b');
});

test('retryable error is delivered but does not settle the active turn', async () => {
    const client = new CodexAppClient();
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return { turn: { id: 'turn-a' } };
    });
    await client.startThread('scope-a', laneOptions);
    await client.startTurn('scope-a', 'hello');
    const seen: string[] = [];
    client.on('notification:scope-a', (method) => { seen.push(method); });

    client['handleLine'](JSON.stringify({
        method: 'error',
        params: {
            threadId: 'thread-a',
            turnId: 'turn-a',
            willRetry: true,
            error: { message: 'retrying' },
        },
    }));
    assert.deepEqual(seen, ['error']);
    assert.equal(client.getActiveTurnId('scope-a'), 'turn-a');

    client['handleLine'](JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } },
    }));
    assert.equal(client.getActiveTurnId('scope-a'), null);
});

test('same-scope overlapping turn and rebind operations fail closed', async () => {
    const client = new CodexAppClient();
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return { turn: { id: 'turn-a' } };
    });
    await client.startThread('scope-a', laneOptions);
    await client.startTurn('scope-a', 'first');

    await assert.rejects(client.startTurn('scope-a', 'second'), /already has turn operation/);
    await assert.rejects(client.startThread('scope-a', laneOptions), /already has turn operation/);
});

test('non-terminal overflow evicts the oldest buffered notification first', async () => {
    const client = new CodexAppClient();
    let resolveTurn!: (result: unknown) => void;
    const turnResponse = new Promise<unknown>((resolve) => { resolveTurn = resolve; });
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return turnResponse;
    });
    await client.startThread('scope-a', laneOptions);
    const seen: string[] = [];
    client.on('notification:scope-a', (_method, params) => { seen.push(String(params['delta'])); });
    const starting = client.startTurn('scope-a', 'hello');
    for (let i = 0; i < 129; i += 1) {
        client['handleLine'](JSON.stringify({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-a', turnId: 'turn-a', delta: `d${i}` },
        }));
    }
    resolveTurn({ turn: { id: 'turn-a' } });
    await starting;

    assert.equal(seen.length, 128);
    assert.equal(seen[0], 'd1');
    assert.equal(seen.at(-1), 'd128');
});

test('terminal-full buffer explicitly fails the pending turn operation', async () => {
    const client = new CodexAppClient();
    const never = new Promise<unknown>(() => {});
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return never;
    });
    await client.startThread('scope-a', laneOptions);
    const starting = client.startTurn('scope-a', 'hello');
    for (let i = 0; i < 129; i += 1) {
        client['handleLine'](JSON.stringify({
            method: 'error',
            params: {
                threadId: 'thread-a', turnId: 'turn-a', willRetry: true,
                error: { message: `retry-${i}` },
            },
        }));
    }

    await assert.rejects(starting, /capacity-terminal-full/);
});

test('non-terminal TTL expiry drops with diagnostics before replay', async () => {
    const client = new CodexAppClient();
    Object.defineProperty(client, 'pendingNotificationTtlMs', { value: 5 });
    let resolveTurn!: (result: unknown) => void;
    const turnResponse = new Promise<unknown>((resolve) => { resolveTurn = resolve; });
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return turnResponse;
    });
    await client.startThread('scope-a', laneOptions);
    const seen: string[] = [];
    client.on('notification:scope-a', (method) => { seen.push(method); });
    const expired = new Promise<void>((resolve) => {
        client.on('unrouted-notification', (entry) => {
            if (entry.reason === 'ttl-expired') resolve();
        });
    });
    const starting = client.startTurn('scope-a', 'hello');
    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'expired' },
    }));
    await expired;
    resolveTurn({ turn: { id: 'turn-a' } });
    await starting;
    assert.deepEqual(seen, []);
});

test('terminal TTL expiry explicitly fails the pending turn operation', async () => {
    const client = new CodexAppClient();
    Object.defineProperty(client, 'pendingNotificationTtlMs', { value: 5 });
    const never = new Promise<unknown>(() => {});
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-a' } };
        return never;
    });
    await client.startThread('scope-a', laneOptions);
    const starting = client.startTurn('scope-a', 'hello');
    client['handleLine'](JSON.stringify({
        method: 'error',
        params: {
            threadId: 'thread-a', turnId: 'turn-a', willRetry: true,
            error: { message: 'expires' },
        },
    }));
    await assert.rejects(starting, /ttl-terminal-expired/);
});

test('closeScope rejects active lanes and cleans idle state, latch, listener, and index', async () => {
    const active = new CodexAppClient();
    injectRequest(active, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-active' } };
        return { turn: { id: 'turn-active' } };
    });
    await active.startThread('scope-active', laneOptions);
    await active.startTurn('scope-active', 'hello');
    await assert.rejects(active.closeScope('scope-active'), /Cannot close active scope/);

    const idle = new CodexAppClient();
    const requests: string[] = [];
    injectRequest(idle, async (method) => {
        requests.push(method);
        return { thread: { id: 'thread-idle' } };
    });
    await idle.startThread('scope-idle', laneOptions);
    await idle.interruptTurn('scope-idle');
    const listener = idle.listenTurn('scope-idle', { onNotification: () => {}, onStderr: () => {} });
    assert.equal(idle.listenerCount('notification:scope-idle'), 1);
    await idle.closeScope('scope-idle');

    assert.equal(idle.getThreadId('scope-idle'), null);
    assert.equal(idle.getActiveTurnId('scope-idle'), null);
    assert.equal(idle.listenerCount('notification:scope-idle'), 0);
    assert.equal(requests.at(-1), 'thread/unsubscribe');
    listener.dispose();

    // Checking the closed scope's own fields is not enough: the reverse index is
    // what stops a thread from being claimed twice, so the proof that it was
    // released is that another scope can now bind the same thread.
    const reclaimed = new CodexAppClient();
    injectRequest(reclaimed, async () => ({ thread: { id: 'thread-shared' } }));
    await reclaimed.startThread('scope-first', laneOptions);
    await reclaimed.closeScope('scope-first');
    await reclaimed.startThread('scope-second', laneOptions);
    assert.equal(reclaimed.getThreadId('scope-second'), 'thread-shared',
        'closing a scope must release its thread for another scope to claim');
});

test('process death makes every lane terminal and rejects pending operations', async () => {
    const client = new CodexAppClient();
    const never = new Promise<unknown>(() => {});
    injectRequest(client, async (method, params) => {
        if (method === 'thread/start') return { thread: { id: String(params['cwd']) } };
        return never;
    });
    await client.startThread('scope-a', { ...laneOptions, cwd: 'thread-a' });
    await client.startThread('scope-b', { ...laneOptions, cwd: 'thread-b' });
    const pending = client.startTurn('scope-a', 'hello');
    client['handleProcessDeath']('test process death');

    await assert.rejects(pending, /test process death/);
    await assert.rejects(client.startTurn('scope-b', 'after death'), /client is terminal/);
    await assert.rejects(client.startThread('scope-c', laneOptions), /client is terminal/);
    assert.equal(client.getActiveTurnId('scope-a'), null);
    assert.equal(client.getActiveTurnId('scope-b'), null);

    // The rejections above come from the client-wide terminal flag, so they pass
    // even if the individual lanes were left usable. Read the lane rows to prove
    // each one was marked, which is what stops a lane from being reused.
    const lanes = client['scopes'] as Map<string, { operation: string }>;
    assert.deepEqual(
        [...lanes.values()].map((lane) => lane.operation),
        ['terminal', 'terminal'],
        'every lane must be marked terminal, not just the client',
    );
});

test('legacy and scoped lane APIs cannot be mixed on one client', async () => {
    const scoped = new CodexAppClient();
    injectRequest(scoped, async () => ({ thread: { id: 'thread-a' } }));
    await scoped.startThread('scope-a', laneOptions);
    assert.throws(
        () => scoped.listenTurn({ onNotification: () => {}, onStderr: () => {} }),
        /Cannot mix legacy.*scoped API/,
    );

    const legacy = new CodexAppClient();
    legacy.threadId = 'legacy-thread';
    await assert.rejects(
        legacy.startThread('scope-a', laneOptions),
        /Cannot mix scoped.*legacy API/,
    );
});
