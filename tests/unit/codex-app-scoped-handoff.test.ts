import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppClient } from '../../src/agent/codex-app-client.ts';

const laneOptions = {
    model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false,
};

async function bindScopedThread(client: CodexAppClient, scope: string, threadId: string): Promise<void> {
    Object.defineProperty(client, 'request', {
        configurable: true,
        value: async () => ({ thread: { id: threadId } }),
    });
    await client.startThread(scope, { ...laneOptions, cwd: threadId });
}
test('a lifecycle listener leaves the scoped handoff for the consumer and replay stays FIFO', async () => {
    const client = new CodexAppClient();
    const lifecycle: string[] = [];
    client.listenTurn('scope-a', {
        role: 'lifecycle',
        onNotification: (_method, params) => { lifecycle.push(String(params['status'])); },
        onStderr: () => {},
    });
    await bindScopedThread(client, 'scope-a', 'thread-a');
    client['handleLine'](JSON.stringify({
        method: 'thread/status/changed', params: { threadId: 'thread-a', status: 'buffered' },
    }));

    const consumer: string[] = [];
    client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => {
            const status = String(params['status']);
            consumer.push(status);
            if (status === 'buffered') {
                client['handleLine'](JSON.stringify({
                    method: 'thread/status/changed',
                    params: { threadId: 'thread-a', status: 'during-replay' },
                }));
            }
        },
        onStderr: () => {},
    });

    assert.deepEqual(consumer, ['buffered', 'during-replay']);
    assert.deepEqual(lifecycle, ['buffered', 'during-replay']);
    const second: string[] = [];
    client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => { second.push(String(params['status'])); },
        onStderr: () => {},
    });
    assert.deepEqual(second, [], 'only the first consumer after an idle gap receives the handoff');
});

test('attaching lane A does not drain lane B', async () => {
    const client = new CodexAppClient();
    await bindScopedThread(client, 'scope-a', 'thread-a');
    await bindScopedThread(client, 'scope-b', 'thread-b');
    for (const [threadId, status] of [['thread-a', 'a'], ['thread-b', 'b']] as const) {
        client['handleLine'](JSON.stringify({
            method: 'thread/status/changed', params: { threadId, status },
        }));
    }

    const laneA: string[] = [];
    client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => { laneA.push(String(params['status'])); },
        onStderr: () => {},
    });
    assert.deepEqual(laneA, ['a']);

    const laneB: string[] = [];
    client.listenTurn('scope-b', {
        role: 'consumer',
        onNotification: (_method, params) => { laneB.push(String(params['status'])); },
        onStderr: () => {},
    });
    assert.deepEqual(laneB, ['b']);
});

test('a scoped consumer gap is handed to the next consumer exactly once', async () => {
    const client = new CodexAppClient();
    await bindScopedThread(client, 'scope-a', 'thread-a');
    const first: string[] = [];
    const firstListener = client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => { first.push(String(params['status'])); },
        onStderr: () => {},
    });
    client['handleLine'](JSON.stringify({
        method: 'thread/status/changed', params: { threadId: 'thread-a', status: 'live' },
    }));
    firstListener.dispose();
    client['handleLine'](JSON.stringify({
        method: 'thread/status/changed', params: { threadId: 'thread-a', status: 'gap' },
    }));

    const second: string[] = [];
    client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => { second.push(String(params['status'])); },
        onStderr: () => {},
    });
    assert.deepEqual(first, ['live']);
    assert.deepEqual(second, ['gap']);
});

test('a partial scoped replay failure restores only the throwing entry and later entries', async () => {
    const client = new CodexAppClient();
    await bindScopedThread(client, 'scope-a', 'thread-a');
    for (const status of ['first', 'second']) {
        client['handleLine'](JSON.stringify({
            method: 'thread/status/changed', params: { threadId: 'thread-a', status },
        }));
    }

    const failed: string[] = [];
    assert.throws(() => client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => {
            const status = String(params['status']);
            failed.push(status);
            if (status === 'second') throw new Error('scoped replay failed');
        },
        onStderr: () => {},
    }), /scoped replay failed/);
    assert.equal(client.listenerCount('notification:scope-a'), 0);

    const recovered: string[] = [];
    client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => { recovered.push(String(params['status'])); },
        onStderr: () => {},
    });
    assert.deepEqual(failed, ['first', 'second']);
    assert.deepEqual(recovered, ['second']);
});

test('scoped handoff overflow evicts the oldest notification and remains bounded', async () => {
    const client = new CodexAppClient();
    await bindScopedThread(client, 'scope-a', 'thread-a');
    const evicted: string[] = [];
    client.on('unrouted-notification', (entry: { params: Record<string, unknown>; reason: string }) => {
        if (entry.reason === 'pre-listener-overflow') evicted.push(String(entry.params['status']));
    });
    for (let index = 0; index < 129; index += 1) {
        client['handleLine'](JSON.stringify({
            method: 'thread/status/changed',
            params: { threadId: 'thread-a', status: `status-${index}` },
        }));
    }
    assert.deepEqual(evicted, ['status-0']);

    const replayed: string[] = [];
    client.listenTurn('scope-a', {
        role: 'consumer',
        onNotification: (_method, params) => { replayed.push(String(params['status'])); },
        onStderr: () => {},
    });
    assert.equal(replayed.length, 128);
    assert.equal(replayed[0], 'status-1');
    assert.equal(replayed.at(-1), 'status-128');
});

test('host handoff preserves pre-listener, replay-time, and consumer-gap order', async () => {
    const client = new CodexAppClient();
    // initialize can emit host notifications before the first scoped lane fixes
    // the API mode; the scoped host handoff must survive that transition.
    client['handleLine'](JSON.stringify({ method: 'configWarning', params: { message: 'before' } }));
    await bindScopedThread(client, 'scope-a', 'thread-a');

    const first: string[] = [];
    const firstListener = client.listenHostNotifications({
        onNotification: (method, params) => {
            first.push(`${method}:${String(params['message'])}`);
            if (params['message'] === 'before') {
                client['handleLine'](JSON.stringify({
                    method: 'deprecationNotice', params: { message: 'during' },
                }));
            }
        },
    });
    assert.deepEqual(first, ['configWarning:before', 'deprecationNotice:during']);
    firstListener.dispose();
    client['handleLine'](JSON.stringify({ method: 'configWarning', params: { message: 'gap' } }));

    const second: string[] = [];
    client.listenHostNotifications({
        onNotification: (method, params) => { second.push(`${method}:${String(params['message'])}`); },
    });
    assert.deepEqual(second, ['configWarning:gap']);
});

test('a throwing host replay handler detaches and preserves only the failed suffix', async () => {
    const client = new CodexAppClient();
    await bindScopedThread(client, 'scope-a', 'thread-a');
    client['handleLine'](JSON.stringify({ method: 'configWarning', params: { message: 'first' } }));
    client['handleLine'](JSON.stringify({ method: 'deprecationNotice', params: { message: 'second' } }));

    assert.throws(() => client.listenHostNotifications({
        onNotification: (_method, params) => {
            if (params['message'] === 'second') throw new Error('host replay failed');
        },
    }), /host replay failed/);
    assert.equal(client.listenerCount('host-notification'), 0);
    assert.equal(client.listenerCount('notification'), 0);

    const recovered: string[] = [];
    client.listenHostNotifications({
        onNotification: (_method, params) => { recovered.push(String(params['message'])); },
    });
    assert.deepEqual(recovered, ['second']);
});

test('host handoff overflow uses the shared bound and reports the evicted notification', async () => {
    const client = new CodexAppClient();
    await bindScopedThread(client, 'scope-a', 'thread-a');
    const evicted: string[] = [];
    client.on('unrouted-notification', (entry: { params: Record<string, unknown>; reason: string }) => {
        if (entry.reason === 'pre-listener-overflow') evicted.push(String(entry.params['message']));
    });
    for (let index = 0; index < 129; index += 1) {
        client['handleLine'](JSON.stringify({
            method: 'configWarning', params: { message: `warning-${index}` },
        }));
    }

    const replayed: string[] = [];
    client.listenHostNotifications({
        onNotification: (_method, params) => { replayed.push(String(params['message'])); },
    });
    assert.deepEqual(evicted, ['warning-0']);
    assert.equal(replayed.length, 128);
    assert.equal(replayed[0], 'warning-1');
    assert.equal(replayed.at(-1), 'warning-128');
});
