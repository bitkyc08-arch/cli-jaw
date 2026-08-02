import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppClient } from '../../src/agent/codex-app-client.ts';

test('listenTurn dispose removes exactly its attached listener references', () => {
    const client = new CodexAppClient();
    const seen: string[] = [];
    const scope = client.listenTurn({
        onNotification: (method) => { seen.push(`notification:${method}`); },
        onStderr: (text) => { seen.push(`stderr:${text}`); },
        onExit: (code) => { seen.push(`exit:${code}`); },
        onError: (err) => { seen.push(`error:${err.message}`); },
        onInterruptFailed: (err) => { seen.push(`interrupt:${err.message}`); },
    });

    client.emit('notification', 'turn/started', {});
    client.emit('stderr', 'wire');
    client.emit('exit', 0, null);
    client.emit('error', new Error('spawn'));
    client.emit('interrupt-failed', new Error('interrupt'));
    scope.dispose();
    scope.dispose();

    assert.deepEqual(seen, [
        'notification:turn/started', 'stderr:wire', 'exit:0', 'error:spawn', 'interrupt:interrupt',
    ]);
    for (const event of ['notification', 'stderr', 'exit', 'error', 'interrupt-failed']) {
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
