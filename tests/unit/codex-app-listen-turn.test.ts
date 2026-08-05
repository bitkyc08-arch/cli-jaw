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
