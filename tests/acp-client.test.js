import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/acp-client.js';

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
