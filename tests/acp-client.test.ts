import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/cli/acp-client.ts';

test('AcpClient buildSpawnArgs: auto includes full allow-all flags', () => {
    const acp = new AcpClient({ permissions: 'auto', model: 'claude-opus-4.6' });
    const args = acp.buildSpawnArgs();

    assert.ok(args.includes('--acp'));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('claude-opus-4.6'));
    assert.ok(args.includes('--allow-all-tools'));
    assert.ok(args.includes('--allow-all-paths'));
    assert.ok(args.includes('--allow-all-urls'));
});

test('AcpClient buildSpawnArgs: yolo includes full allow-all flags', () => {
    const acp = new AcpClient({ permissions: 'yolo' });
    const args = acp.buildSpawnArgs();

    assert.ok(args.includes('--allow-all-tools'));
    assert.ok(args.includes('--allow-all-paths'));
    assert.ok(args.includes('--allow-all-urls'));
});

test('AcpClient buildSpawnArgs: safe mode omits allow-all flags', () => {
    const acp = new AcpClient({ permissions: 'safe' });
    const args = acp.buildSpawnArgs();

    assert.ok(!args.includes('--allow-all-tools'));
    assert.ok(!args.includes('--allow-all-paths'));
    assert.ok(!args.includes('--allow-all-urls'));
});

test('AcpClient handles agent requests (id + method) before notifications', () => {
    const acp = new AcpClient();
    let handled = null;
    let notified = false;

    acp._handleAgentRequest = (msg) => {
        handled = msg;
    };
    acp.on('session/request_permission', () => {
        notified = true;
    });

    acp._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { options: [{ value: 'allow' }] },
    }));

    assert.equal(handled?.id, 7);
    assert.equal(handled?.method, 'session/request_permission');
    assert.equal(notified, false);
});

test('AcpClient emits notifications (method without id)', () => {
    const acp = new AcpClient();
    let params = null;

    acp.on('session/update', (value) => {
        params = value;
    });

    acp._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'plan' } },
    }));

    assert.deepEqual(params, { update: { sessionUpdate: 'plan' } });
});

test('AcpClient request resolves from matching response id', async () => {
    const acp = new AcpClient();
    const writes = [];
    acp.proc = {
        stdin: {
            writable: true,
            write: (line) => writes.push(line),
        },
    };

    const promise = acp.request('initialize', { protocolVersion: 1 }, 1000);
    const sent = JSON.parse(String(writes[0] || '').trim());
    acp._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        result: { ok: true },
    }));

    await assert.doesNotReject(promise);
    const out = await promise;
    assert.deepEqual(out, { ok: true });
});

test('AcpClient replies to colliding permission request without settling pending client request', async () => {
    const acp = new AcpClient();
    const writes: string[] = [];
    // Only stdin is consumed here; keep the real request, dispatcher and permission handler.
    acp.proc = {
        stdin: {
            writable: true,
            write: (line: string) => { writes.push(line); return true; },
        },
    } as unknown as NonNullable<AcpClient['proc']>;

    const promise = acp.request('session/prompt', { sessionId: 'collision-fixture' }, 1000);
    const sent = JSON.parse(writes[0]!);
    const originalPending = acp._pending.get(sent.id);
    let settled = false;
    const observed = promise.then(
        () => { settled = true; },
        () => { settled = true; },
    );
    const permissionParams = { options: [
        { id: 'deny_this', name: 'Deny' },
        { id: 'approve_this', name: 'Approve' },
    ] };
    const permissionEvents: unknown[] = [];
    acp.on('session/request_permission', params => permissionEvents.push(params));

    try {
        assert.ok(originalPending);
        acp._handleLine(JSON.stringify({
            jsonrpc: '2.0', id: sent.id,
            method: 'session/request_permission', params: permissionParams,
        }));
        await Promise.resolve();

        assert.equal(writes.length, 2, 'peer permission reply must precede the prompt response');
        assert.deepEqual(JSON.parse(writes[1]!), {
            jsonrpc: '2.0', id: sent.id,
            result: { outcome: { outcome: 'selected', optionId: 'approve_this' } },
        });
        assert.deepEqual(permissionEvents, [permissionParams]);
        assert.equal(settled, false, 'peer request must not settle the client promise');
        assert.equal(acp._pending.size, 1);
        assert.equal(acp._pending.get(sent.id), originalPending);

        acp._handleLine(JSON.stringify({
            jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' },
        }));
        assert.deepEqual(await promise, { stopReason: 'end_turn' });
        assert.equal(acp._pending.size, 0);
        assert.equal(writes.length, 2);
    } finally {
        if (originalPending?.timer) clearTimeout(originalPending.timer);
        acp._pending.delete(sent.id);
        originalPending?.resolve(undefined);
        await observed;
    }
});

test('AcpClient request rejects immediately when stdin is not writable', async () => {
    const acp = new AcpClient();
    await assert.rejects(
        acp.request('initialize', {}, 1000),
        /stdin is not writable/
    );
});

test('AcpClient permission response accepts id-based options', () => {
    const acp = new AcpClient();
    const writes = [];
    acp._write = (msg) => writes.push(msg);

    acp._handleAgentRequest({
        id: 99,
        method: 'session/request_permission',
        params: {
            options: [{ id: 'approve_this', name: 'Approve' }],
        },
    });

    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 99);
    assert.equal(
        writes[0].result?.outcome?.optionId,
        'approve_this'
    );
});

test('requestWithHeartbeat resolves and cleans up timers on response', async () => {
    const acp = new AcpClient();
    const writes = [];
    acp.proc = {
        stdin: {
            writable: true,
            write: (line) => writes.push(line),
        },
    };

    const { promise, activityPing } = acp.requestWithActivityTimeout('session/prompt', { text: 'hi' }, 500, 2000);

    // Simulate activity pings (like session/update events)
    activityPing();
    activityPing();

    // Respond with a result
    const sent = JSON.parse(String(writes[0] || '').trim());
    acp._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        result: { ok: true },
    }));

    const out = await promise;
    assert.deepEqual(out, { ok: true });
});

test('requestWithActivityTimeout rejects on idle timeout when no activity', async () => {
    const acp = new AcpClient();
    acp.proc = {
        stdin: {
            writable: true,
            write: () => { },
        },
    };

    const { promise } = acp.requestWithActivityTimeout('session/prompt', {}, 100, 5000);

    await assert.rejects(promise, /idle 0.1s/);
});

test('_handleLine resets idle timer via _activityPing on valid JSON', async () => {
    const acp = new AcpClient();
    let pingCount = 0;
    acp._activityPing = () => { pingCount++; };

    // Valid JSON-RPC notification → should trigger ping
    acp._handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }));
    assert.equal(pingCount, 1);

    // Another message → ping again
    acp._handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } }));
    assert.equal(pingCount, 2);

    // Invalid JSON → no ping
    acp._handleLine('not json at all');
    assert.equal(pingCount, 2);
});

function createCapturedClient() {
    const acp = new AcpClient();
    const writes: string[] = [];
    // Fake only the child stdin boundary; exercise the real serializer and handlers.
    acp.proc = {
        stdin: {
            writable: true,
            write: (line: string) => { writes.push(line); return true; },
        },
    } as unknown as NonNullable<AcpClient['proc']>;
    return { acp, writes };
}

test('AcpClient ignores malformed, invalid-version and ambiguous envelopes without pending or activity effects', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { acp, writes } = createCapturedClient();
    const promise = acp.request('session/prompt', {}, 1000);
    const id = JSON.parse(writes[0]!).id;
    const pending = acp._pending.get(id);
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    let pings = 0;
    acp._activityPing = () => { pings++; };
    const emitted = t.mock.method(acp, 'emit');
    const logged = t.mock.method(console, 'log', () => {});
    const previousDebug = process.env['DEBUG'];
    process.env['DEBUG'] = '1';
    const response = { jsonrpc: '2.0', id, result: 'must-not-resolve' };
    const callback = { jsonrpc: '2.0', id, method: 'session/request_permission' };
    const invalidLines = [
        '', '  ', 'not-json secret-payload', '{', 'null', 'true', '42', '[]',
        JSON.stringify([response]),
        JSON.stringify({ id, result: 'missing-version' }),
        JSON.stringify({ ...response, jsonrpc: '1.0' }),
        JSON.stringify({ ...response, id: null }),
        JSON.stringify({ ...response, id: Number.MAX_SAFE_INTEGER + 1 }),
        JSON.stringify({ ...callback, method: '' }),
        JSON.stringify({ ...callback, method: 7 }),
        JSON.stringify({ ...callback, result: null }),
        JSON.stringify({ ...callback, error: { code: -1, message: 'ambiguous' } }),
        JSON.stringify({ ...response, error: { code: -1, message: 'ambiguous' } }),
        JSON.stringify({ jsonrpc: '2.0', id }),
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: 'bad', message: 'bad' } }),
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 7 } }),
    ];
    try {
        assert.ok(pending);
        for (const line of invalidLines) {
            assert.doesNotThrow(() => acp._handleLine(line));
            await Promise.resolve();
            assert.equal(settled, false);
            assert.equal(acp._pending.get(id), pending);
            assert.equal(acp._pending.size, 1);
            assert.equal(writes.length, 1);
            assert.equal(pings, 0);
            assert.equal(emitted.mock.callCount(), 0);
            assert.equal(logged.mock.callCount(), 0);
        }
        acp._handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: null }));
        assert.equal(await promise, null);
        assert.equal(acp._pending.size, 0);
        assert.equal(pings, 1);
    } finally {
        if (previousDebug === undefined) delete process.env['DEBUG'];
        else process.env['DEBUG'] = previousDebug;
        if (pending?.timer) clearTimeout(pending.timer);
        acp._pending.delete(id);
        pending?.resolve(undefined);
    }
});

test('AcpClient ignores late, duplicate and unmatched responses while a new request remains pending', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { acp, writes } = createCapturedClient();
    const expired = acp.request('session/prompt', {}, 1000);
    const expiredId = JSON.parse(writes[0]!).id;
    const rejected = assert.rejects(expired, /ACP request timeout: session\/prompt/);
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(acp._pending.size, 0);

    const promise = acp.request('session/prompt', {}, 1000);
    const id = JSON.parse(writes[1]!).id;
    const pending = acp._pending.get(id);
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    const emitted = t.mock.method(acp, 'emit');
    try {
        assert.ok(pending);
        for (const lateId of [expiredId, expiredId, 'unmatched', String(id)]) {
            acp._handleLine(JSON.stringify({ jsonrpc: '2.0', id: lateId, result: 'late' }));
            acp._handleLine(JSON.stringify({
                jsonrpc: '2.0', id: lateId, error: { code: -1, message: 'late' },
            }));
        }
        await Promise.resolve();
        assert.equal(settled, false);
        assert.equal(acp._pending.get(id), pending);
        assert.equal(acp._pending.size, 1);
        assert.equal(emitted.mock.callCount(), 0);
        assert.equal(writes.length, 2);

        const update = { update: { sessionUpdate: 'plan' } };
        acp._handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: update }));
        assert.deepEqual(emitted.mock.calls[0]?.arguments, ['session/update', update]);
        assert.equal(settled, false);
        assert.equal(acp._pending.get(id), pending);

        acp._handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: null }));
        assert.equal(await promise, null);
        acp._handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: 'duplicate' }));
        assert.equal(await promise, null);
        assert.equal(acp._pending.size, 0);
        assert.equal(emitted.mock.callCount(), 1);
        assert.equal(writes.length, 2);
    } finally {
        if (pending?.timer) clearTimeout(pending.timer);
        acp._pending.delete(id);
        pending?.resolve(undefined);
    }
});
