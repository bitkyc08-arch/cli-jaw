import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import {
    CodexAppClient,
    type CodexAppClientOptions,
    type CodexThreadOptions,
} from '../../src/agent/codex-app-client.ts';

type Frame = Record<string, unknown>;
const threadOptions: CodexThreadOptions = {
    model: 'fixture-model', effort: 'medium', cwd: '/tmp', fastMode: false,
};
const approvalParams = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
const commandApproval = 'item/commandExecution/requestApproval';
const fileApproval = 'item/fileChange/requestApproval';
const permissionApproval = 'item/permissions/requestApproval';
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

// In-memory app-server transport: exercise request serialization and reply
// capture without launching a process or replacing the client's RPC methods.
function fakeServer(t: TestContext, options: CodexAppClientOptions = {}) {
    const client = new CodexAppClient(options);
    const requests: Frame[] = [];
    const replies: Frame[] = [];
    let threadSequence = 0;
    let autoRespond = true;
    const proc = new ChildProcess();
    const input = new Writable({
        write(chunk, _encoding, callback) {
            const frame = JSON.parse(String(chunk)) as Frame;
            if (typeof frame['method'] === 'string') {
                requests.push(frame);
                if (autoRespond && frame['id'] !== undefined) {
                    const params = frame['params'] as Frame;
                    const result = frame['method'] === 'thread/start'
                        ? { thread: { id: `thread-${++threadSequence}` } }
                        : frame['method'] === 'thread/resume'
                            ? { thread: { id: params['threadId'] } }
                            : frame['method'] === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
                    queueMicrotask(() => receive({ id: frame['id'], result }));
                }
            } else {
                replies.push(frame);
            }
            callback();
        },
        final(callback) {
            callback();
            queueMicrotask(() => proc.emit('exit', 0, null));
        },
    });
    Object.defineProperty(proc, 'stdin', { value: input });
    client.proc = proc;
    proc.on('exit', (code, signal) => client['handleProcessExit'](code, signal));
    const receive = (frame: Frame) => client['handleLine'](JSON.stringify(frame));
    t.after(() => { client.cleanup(); input.destroy(); });
    return {
        client, requests, replies, receive,
        pauseResponses() { autoRespond = false; },
        request(id: number | string, method = commandApproval, params: Frame = approvalParams) {
            receive({ id, method, params });
        },
    };
}

test('ordinary callers retain start/resume policy defaults and turn/start inherits them', async (t) => {
    const { client, requests } = fakeServer(t);
    await client.startThread('ordinary', threadOptions);
    await client.resumeThread('ordinary', 'thread-1', threadOptions);
    await client.startTurn('ordinary', 'hello');
    for (const request of requests.slice(0, 2)) {
        const params = request['params'] as Frame;
        assert.equal(params['approvalPolicy'], 'never');
        assert.equal(params['sandbox'], 'danger-full-access');
    }
    assert.deepEqual(requests.map((request) => request['method']), ['thread/start', 'thread/resume', 'turn/start']);
    assert.deepEqual(requests[2]?.['params'], {
        threadId: 'thread-1', input: [{ type: 'text', text: 'hello', text_elements: [] }],
        effort: 'medium', summary: 'detailed',
    });
});

test('rebind copies changed policy fields and removes omitted fields on both RPC paths', async (t) => {
    const { client, requests } = fakeServer(t);
    await client.startThread('code', { ...threadOptions, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    await client.resumeThread('code', 'thread-1', { ...threadOptions, approvalPolicy: 'never', sandbox: 'read-only' });
    await client.startThread('code', { ...threadOptions, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    await client.resumeThread('code', 'thread-2', { ...threadOptions, sandbox: 'read-only' });
    await client.startThread('code', { ...threadOptions, approvalPolicy: 'untrusted' });
    await client.resumeThread('code', 'thread-3', threadOptions);
    assert.deepEqual(requests.map((request) => {
        const params = request['params'] as Frame;
        return [request['method'], params['approvalPolicy'], params['sandbox']];
    }), [
        ['thread/start', 'untrusted', 'workspace-write'],
        ['thread/resume', 'never', 'read-only'],
        ['thread/start', 'on-request', 'workspace-write'],
        ['thread/resume', 'never', 'read-only'],
        ['thread/start', 'untrusted', 'danger-full-access'],
        ['thread/resume', 'never', 'danger-full-access'],
    ]);
});

const fallbackCases: Array<[string, Frame]> = [
    [commandApproval, { decision: 'decline' }],
    [fileApproval, { decision: 'decline' }],
    [permissionApproval, { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null }],
    ['item/tool/requestUserInput', { answers: {} }],
    ['execCommandApproval', { decision: 'denied' }],
    ['applyPatchApproval', { decision: 'denied' }],
    ['unknown/requestApproval', {}],
    ['constructor', {}],
];

test('ordinary clients keep every built-in decline response', (t) => {
    const server = fakeServer(t);
    for (const [id, [method, result]] of fallbackCases.entries()) {
        server.request(id, method);
        assert.deepEqual(server.replies[id], { jsonrpc: '2.0', id, result });
    }
    assert.equal(server.replies.length, fallbackCases.length);
});

test('unsupported questions, legacy approvals and unknown methods never reach the delegate', (t) => {
    let calls = 0;
    const server = fakeServer(t, { serverRequest: async () => { calls++; return { decision: 'accept' }; } });
    for (const [id, [method, result]] of fallbackCases.slice(3).entries()) {
        server.request(id, method);
        assert.deepEqual(server.replies[id], { jsonrpc: '2.0', id, result });
    }
    assert.equal(calls, 0);
});

for (const method of [commandApproval, fileApproval]) {
    for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel']) {
        test(`${method} delegates ${decision} with exact native IDs`, async (t) => {
            const observed: unknown[][] = [];
            const server = fakeServer(t, {
                serverRequest: async (receivedMethod, params, id, signal) => {
                    observed.push([receivedMethod, params, id, signal.aborted]);
                    return { decision };
                },
            });
            server.request('rpc-opaque', method);
            await drain();
            assert.deepEqual(observed, [[method, approvalParams, 'rpc-opaque', false]]);
            assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id: 'rpc-opaque', result: { decision } }]);
        });
    }
}

test('structured permission result is passed through without inferring a grant', async (t) => {
    const result = { permissions: { network: { enabled: true } }, scope: 'turn' };
    const server = fakeServer(t, { serverRequest: async () => result });
    server.request(7, permissionApproval, { ...approvalParams, permissions: { network: { enabled: true } } });
    await drain();
    assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id: 7, result }]);
});

test('raw missing/mismatched ownership is left for the delegate to decline', async (t) => {
    const observed: Frame[] = [];
    const server = fakeServer(t, {
        serverRequest: async (_method, params) => {
            observed.push(params);
            if (params['threadId'] !== 'thread-1' || params['turnId'] !== 'turn-1' || params['itemId'] !== 'item-1') return undefined;
            return { decision: 'accept' };
        },
    });
    await server.client.startThread('code', threadOptions);
    await server.client.startTurn('code', 'hello');
    const inputs = [
        { ...approvalParams, threadId: 'foreign-thread' },
        { ...approvalParams, turnId: 'old-turn' },
        { ...approvalParams, itemId: 'foreign-item' },
        { itemId: 'item-1' },
    ];
    for (const [id, params] of inputs.entries()) server.request(id, commandApproval, params);
    await drain();
    assert.deepEqual(observed, inputs);
    assert.deepEqual(server.replies, inputs.map((_params, id) => ({ jsonrpc: '2.0', id, result: { decision: 'decline' } })));
});

test('a delegate can decline when its captured turn becomes stale during approval', async (t) => {
    const answer = deferred<void>();
    let currentTurn = 'turn-1';
    const server = fakeServer(t, {
        serverRequest: async (_method, params) => {
            await answer.promise;
            return currentTurn === params['turnId'] ? { decision: 'accept' } : undefined;
        },
    });
    server.request(4);
    currentTurn = 'turn-2';
    answer.resolve();
    await drain();
    assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id: 4, result: { decision: 'decline' } }]);
});

for (const failure of ['undefined', 'throw', 'reject'] as const) {
    test(`delegate ${failure} uses the method-specific fallback once`, async (t) => {
        const server = fakeServer(t, {
            serverRequest: () => {
                if (failure === 'throw') throw new Error('handler failed');
                if (failure === 'reject') return Promise.reject(new Error('handler failed'));
                return Promise.resolve(undefined);
            },
        });
        for (const [id, [method]] of fallbackCases.slice(0, 3).entries()) server.request(id, method);
        await drain();
        assert.deepEqual(server.replies, fallbackCases.slice(0, 3).map(([_method, result], id) => ({ jsonrpc: '2.0', id, result })));
    });
}

test('deadline aborts once, declines once and ignores late permission grants', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const answer = deferred<Frame>();
    let aborts = 0;
    const server = fakeServer(t, {
        serverRequest: (_method, _params, _id, signal) => {
            signal.addEventListener('abort', () => { aborts++; });
            return answer.promise;
        },
    });
    server.request('timeout', permissionApproval);
    t.mock.timers.tick(119_999);
    assert.equal(server.replies.length, 0);
    t.mock.timers.tick(1);
    assert.equal(aborts, 1);
    answer.resolve({ permissions: { network: { enabled: true } }, scope: 'turn' });
    await drain();
    t.mock.timers.tick(120_000);
    assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id: 'timeout', result: { permissions: {}, scope: 'turn' } }]);
    assert.equal(aborts, 1);
});

for (const close of ['cleanup', 'graceful', 'kill', 'exit', 'error'] as const) {
    test(`${close} cancels pending decisions before late completion and rejects new delegation`, async (t) => {
        const answer = deferred<Frame>();
        let aborts = 0;
        let calls = 0;
        const server = fakeServer(t, {
            serverRequest: (_method, _params, _id, signal) => {
                calls++;
                signal.addEventListener('abort', () => { aborts++; });
                return answer.promise;
            },
        });
        server.request(1);
        if (close === 'cleanup') server.client.cleanup();
        else if (close === 'graceful') await server.client.closeGracefully();
        else if (close === 'kill') {
            // A signalled process can still have writable stdin while exiting.
            // No OS process exists in this fixture.
            Object.defineProperty(server.client.proc!, 'killed', { value: true });
            server.client.kill();
        } else if (close === 'exit') server.client['handleProcessExit'](1, null);
        else {
            server.client.on('error', () => {});
            server.client['handleProcessError'](new Error('transport failed'));
        }
        assert.equal(aborts, 1);
        const repliesAtClose = server.replies.length;
        answer.resolve({ decision: 'accept' });
        await drain();
        assert.equal(server.replies.length, repliesAtClose);
        assert.ok(server.replies.every((reply) => (reply['result'] as Frame)['decision'] === 'decline'));
        assert.equal(repliesAtClose, 1);
        server.request(2);
        assert.equal(calls, 1);
        server.client.cleanup();
        assert.equal(aborts, 1);
    });
}

test('graceful close cancels before a pending unsubscribe completes', async (t) => {
    const answer = deferred<Frame>();
    let signal: AbortSignal | undefined;
    const server = fakeServer(t, {
        serverRequest: (_method, _params, _id, receivedSignal) => {
            signal = receivedSignal;
            return answer.promise;
        },
    });
    await server.client.startThread('code', threadOptions);
    server.pauseResponses();
    server.request('pending');
    const closing = server.client.closeGracefully();
    assert.equal(signal?.aborted, true);
    assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id: 'pending', result: { decision: 'decline' } }]);
    answer.resolve({ decision: 'accept' });
    await drain();
    assert.equal(server.replies.length, 1);
    const unsubscribe = server.requests.at(-1)!;
    assert.equal(unsubscribe['method'], 'thread/unsubscribe');
    server.receive({ id: unsubscribe['id'], result: {} });
    await closing;
});

test('synchronous close inside the delegate claims decline before the handler returns allow', async (t) => {
    const server = fakeServer(t, {
        serverRequest: () => {
            server.client.cleanup();
            return { decision: 'accept' };
        },
    });
    server.request(5);
    await drain();
    assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id: 5, result: { decision: 'decline' } }]);
});

test('duplicate in-flight RPC IDs open only one decision; numeric and string IDs stay distinct', async (t) => {
    const answer = deferred<Frame>();
    let calls = 0;
    const server = fakeServer(t, { serverRequest: () => { calls++; return answer.promise; } });
    server.request(3);
    server.request(3);
    server.request('3');
    answer.resolve({ decision: 'accept' });
    await drain();
    assert.equal(calls, 2);
    assert.deepEqual(server.replies, [
        { jsonrpc: '2.0', id: 3, result: { decision: 'accept' } },
        { jsonrpc: '2.0', id: '3', result: { decision: 'accept' } },
    ]);
});

test('server request ID collisions do not consume pending client RPC responses', async (t) => {
    const server = fakeServer(t, { serverRequest: async () => ({ decision: 'accept' }) });
    server.pauseResponses();
    const starting = server.client.startThread('code', threadOptions);
    const id = server.requests[0]?.['id'];
    assert.equal(typeof id, 'number');
    server.request(id as number);
    await drain();
    assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id, result: { decision: 'accept' } }]);
    server.receive({ id, result: { thread: { id: 'thread-real' } } });
    assert.equal(await starting, 'thread-real');
});

test('excess pending requests decline without invoking another delegate', (t) => {
    let calls = 0;
    const server = fakeServer(t, {
        serverRequest: () => { calls++; return new Promise<Frame>(() => {}); },
    });
    for (let id = 0; id < 129; id++) server.request(id);
    assert.equal(calls, 128);
    assert.deepEqual(server.replies, [{ jsonrpc: '2.0', id: 128, result: { decision: 'decline' } }]);
    server.client.cleanup();
    assert.equal(server.replies.length, 129);
    assert.equal(new Set(server.replies.map((reply) => reply['id'])).size, 129);
});
