import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppClient } from '../../src/agent/codex-app-client.ts';

test('listenTurn dispose removes exactly its attached listener references', () => {
    const client = new CodexAppClient();
    const seen: string[] = [];
    const scope = client.listenTurn('scope-a', {
        onNotification: (method) => { seen.push(`notification:${method}`); },
        onStderr: (text) => { seen.push(`stderr:${text}`); },
        onExit: (code) => { seen.push(`exit:${code}`); },
        onError: (err) => { seen.push(`error:${err.message}`); },
        onInterruptFailed: (err) => { seen.push(`interrupt:${err.message}`); },
    });

    client.emit('notification:scope-b', 'turn/started', {});
    client.emit('notification:scope-a', 'turn/started', {});
    client.emit('stderr', 'wire');
    client.emit('exit', 0, null);
    client.emit('error', new Error('spawn'));
    client.emit('interrupt-failed:scope-a', new Error('interrupt'));
    scope.dispose();
    scope.dispose();

    assert.deepEqual(seen, [
        'notification:turn/started', 'stderr:wire', 'exit:0', 'error:spawn', 'interrupt:interrupt',
    ]);
    for (const event of ['notification:scope-a', 'stderr', 'exit', 'error', 'interrupt-failed:scope-a']) {
        assert.equal(client.listenerCount(event), 0, `${event} listener leaked`);
    }
});

test('host notifications stay off scoped lanes and reach the host listener once', () => {
    const client = new CodexAppClient();
    const lane: string[] = [];
    const host: string[] = [];
    const laneListener = client.listenTurn('scope-a', {
        onNotification: (method) => { lane.push(method); },
        onStderr: () => {},
    });
    const hostListener = client.listenHostNotifications({
        onNotification: (method) => { host.push(method); },
    });

    client.emit('host-notification', 'account/updated', {});
    assert.deepEqual(lane, []);
    assert.deepEqual(host, ['account/updated']);

    laneListener.dispose();
    hostListener.dispose();
    assert.equal(client.listenerCount('host-notification'), 0);
});

test('legacy listener bridges lane, host, and future raw notifications once each', () => {
    const client = new CodexAppClient();
    const seen: string[] = [];
    const listener = client.listenTurn({
        onNotification: (method) => { seen.push(method); },
        onStderr: () => {},
    });

    client.emit('notification:legacy/default', 'turn/started', {});
    client.emit('host-notification', 'account/updated', {});
    client.emit('notification', 'future/method', {});
    assert.deepEqual(seen, ['turn/started', 'account/updated', 'future/method']);

    listener.dispose();
    for (const event of ['notification:legacy/default', 'host-notification', 'notification']) {
        assert.equal(client.listenerCount(event), 0, `${event} listener leaked`);
    }
});

test('alive getter delegates to current child process state', () => {
    const client = new CodexAppClient();
    const proc = { exitCode: null as number | null, killed: false };
    client.proc = proc as typeof client.proc;
    assert.equal(client.alive, true);
    proc.exitCode = 1;
    assert.equal(client.alive, false);
    proc.exitCode = null;
    proc.killed = true;
    assert.equal(client.alive, false);
});

// The production order is: the pool starts the thread and drains the replay
// buffer, returns the lease, and only then does spawn attach its listener.
// Anything the server sent in that window used to be emitted to nobody, which
// silently dropped it from the raw trace that records every notification.
test('legacy notifications sent before the first listener still arrive exactly once', async () => {
    const client = new CodexAppClient();
    let resolveStart!: (result: unknown) => void;
    const response = new Promise<unknown>((resolve) => { resolveStart = resolve; });
    Object.defineProperty(client, 'request', { value: async () => response });

    const starting = client.startThread({});
    client['handleLine'](JSON.stringify({
        method: 'thread/started',
        params: { thread: { id: 'thread-a' } },
    }));
    resolveStart({ thread: { id: 'thread-a' } });
    await starting;

    // A host-scoped notification lands in the same window.
    client['handleLine'](JSON.stringify({
        method: 'configWarning',
        params: { message: 'stale key' },
    }));

    const seen: string[] = [];
    client.listenTurn({
        onNotification: (method) => { seen.push(method); },
        onStderr: () => {},
    });
    assert.deepEqual(seen, ['thread/started', 'configWarning'],
        'the pre-listener window must be handed over in order');

    const second: string[] = [];
    client.listenTurn({
        onNotification: (method) => { second.push(method); },
        onStderr: () => {},
    });
    assert.deepEqual(second, [], 'the buffer is handed over once, not to every listener');
});

// The pool reuses one client across turns, so there is a gap every time a
// listener is disposed before the next one attaches. Treating "a listener
// existed once" as permanent lost everything that arrived in those gaps.
test('notifications in the gap between listeners are handed to the next one', async () => {
    const client = new CodexAppClient();
    Object.defineProperty(client, 'request', {
        value: async () => ({ thread: { id: 'thread-a' } }),
    });
    await client.startThread({});

    const first: string[] = [];
    const attached = client.listenTurn({
        onNotification: (method) => { first.push(method); },
        onStderr: () => {},
    });
    client['handleLine'](JSON.stringify({ method: 'configWarning', params: { message: 'a' } }));
    assert.deepEqual(first, ['configWarning']);
    attached.dispose();

    client['handleLine'](JSON.stringify({ method: 'configWarning', params: { message: 'b' } }));

    const second: string[] = [];
    client.listenTurn({
        onNotification: (method, params) => { second.push(`${method}:${String(params['message'])}`); },
        onStderr: () => {},
    });
    assert.deepEqual(second, ['configWarning:b'],
        'the gap must be replayed to the next listener, and only what arrived in it');
});

// Only genuinely unrecognised methods take the legacy raw path. A known method
// that arrived malformed is a diagnostic, and letting it through the queue
// would put it back on the raw channel it was supposed to be kept off.
test('malformed known methods do not reach the legacy consumer through the queue', () => {
    const client = new CodexAppClient();
    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a' },
    }));

    const seen: string[] = [];
    client.listenTurn({
        onNotification: (method) => { seen.push(method); },
        onStderr: () => {},
    });
    assert.deepEqual(seen, [], 'a malformed known method stays a diagnostic');
});
