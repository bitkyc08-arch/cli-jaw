import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import express from 'express';
import { AcpConnection } from '../../src/agent/runtime/acp/connection.ts';
import { AcpCallbacks, type AcpRequestOwner } from '../../src/agent/runtime/acp/callbacks.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import { registerRuntimeRequestRoutes } from '../../src/routes/runtime-requests.ts';
import { stringifyTraceValue } from '../../src/trace/redact.ts';
import { decodeRuntimeBody } from '../../src/trace/runtime-body-codec.ts';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';

const raw: unknown[] = [], published: RuntimeEvent[] = [];
let appendFails = false;
mock.module('../../src/trace/activity-journal.js', { namedExports: { markActivityFailure: () => {}, appendActivityBody: (entry: { raw: unknown }) => {
    if (appendFails) return null;
    raw.push(JSON.parse(stringifyTraceValue(entry.raw)));
    return { traceRunId: 'not-an-identity-source', traceSeq: raw.length, detailAvailable: true, detailBytes: 100, rawRetentionStatus: 'available' };
} } });
mock.module('../../src/core/event-bus.js', { namedExports: { publish: (_topic: string, _event: string, data: RuntimeEvent) => {
    published.push(data);
} } });
const { recordRuntimeEvent } = await import('../../src/agent/runtime/events.ts');
test.beforeEach(() => { raw.length = 0; published.length = 0; appendFails = false; });

const originalBinding = { runId: 'run', sessionId: 'chat', scope: 'mention-watch:scope', turnId: 'turn' };
const options = [
    { optionId: 'CANARY_NATIVE_REJECT', name: 'Allow all', kind: 'reject_once' },
    { optionId: 'CANARY_NATIVE_ALLOW', name: 'Bearer CANARY_LABEL_SECRET_LONG', kind: 'allow_once' },
];
function params() {
    return { sessionId: 'native', toolCall: { toolCallId: 'CANARY_NATIVE_TOOL', title: '{"password":"CANARY_TITLE_SECRET"}' }, options };
}
function fixture(t: TestContext, permissions: unknown = 'safe') {
    const changes = new EventEmitter();
    const writes: Record<string, any>[] = [], attempts: RuntimeEventBody[] = [], failures: Error[] = [];
    const callbacksToRelease: Array<() => void> = [];
    const registry = new RuntimeRequests();
    let holdWrites = false, current = true, resolverThrows = false, writeFails = false;
    let callbacks: AcpCallbacks;
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable({ write(chunk, _encoding, callback) {
            writes.push(JSON.parse(String(chunk)));
            changes.emit('change');
            if (writeFails) callback(new Error('private-write-error'));
            else if (holdWrites) callbacksToRelease.push(callback); else callback();
        } }),
    });
    const connection = new AcpConnection(child as unknown as ChildProcessWithoutNullStreams, {
        frame: frame => callbacks.handle(frame),
        failed: error => { failures.push(error); callbacks?.dispose(); changes.emit('change'); },
    });
    function makeOwner(runId = 'run'): AcpRequestOwner {
        const binding = { ...originalBinding, runId };
        const context = { ...binding, parentItemId: 'parent', audience: 'public' as const };
        return { nativeSessionId: 'native', binding, parentItemId: 'parent', isCurrent: () => current,
            emit: body => {
                attempts.push(body);
                const event = recordRuntimeEvent(context, body);
                changes.emit('change');
                return event;
            } };
    }
    let owner: AcpRequestOwner | null = makeOwner();
    callbacks = new AcpCallbacks(connection, { registry, permissions, getOwner: () => {
        if (resolverThrows) throw new Error('private-resolver');
        return owner;
    } });
    const waitFor = (predicate: () => boolean): Promise<void> => {
        if (predicate()) return Promise.resolve();
        return new Promise(resolve => {
            const changed = () => { if (predicate()) { changes.off('change', changed); resolve(); } };
            changes.on('change', changed);
        });
    };
    t.after(async () => {
        callbacks.dispose(); connection.close();
        for (const release of callbacksToRelease.splice(0)) release();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        await new Promise<void>(resolve => setImmediate(resolve));
        changes.removeAllListeners();
    });
    return { registry, connection, callbacks, child, writes, attempts, failures, waitFor,
        get owner() { return owner; },
        setOwner: (runId: string | null) => { owner = runId === null ? null : makeOwner(runId); },
        loseOwner: () => { current = false; }, breakResolver: () => { resolverThrows = true; },
        failWrites: () => { writeFails = true; },
        hold: () => { holdWrites = true; }, release: () => callbacksToRelease.shift()?.(),
        request: (id: string | number, value: unknown = params(), method = 'session/request_permission') => {
            child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: value }) + '\n');
        },
    };
}
async function serve(t: TestContext, registry: RuntimeRequests) {
    const app = express();
    app.use(express.json());
    registerRuntimeRequestRoutes(app, (req, res, next) => {
        if (req.headers.authorization !== 'Bearer fixture-auth') { res.status(401).json({ error: 'Unauthorized' }); return; }
        next();
    }, registry);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
}
const auth = { authorization: 'Bearer fixture-auth', 'content-type': 'application/json' };
function respond(f: ReturnType<typeof fixture>) {
    const pending = f.registry.list('chat')[0]!;
    f.registry.respond(pending.requestId, pending, { optionId: pending.view.fields[0]!.options[1]!.id });
    return pending;
}

test('HTTP decision, public event, raw writer and replay share a safe view while the prompt stays pending', { timeout: 5000 }, async t => {
    const f = fixture(t, ['read', 'mcp.*']);
    const base = await serve(t, f.registry);
    const prompt = f.connection.request('session/prompt', {});
    await prompt.dispatched;
    let promptSettled = false;
    void prompt.result.then(() => { promptSettled = true; }, () => { promptSettled = true; });
    f.request(prompt.id); // independent bidirectional ID collision
    assert.equal(f.writes.length, 1);
    const response = await fetch(base + '/api/runtime/requests?sessionId=chat', { headers: auth });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(Object.hasOwn(body, 'requests'), false);
    const pending = body.data.requests[0];
    const event = published.find(e => e.kind === 'request');
    assert.ok(event?.kind === 'request');
    assert.deepEqual(pending.view, event.view);
    assert.deepEqual(decodeRuntimeBody(raw[0], { ...originalBinding, version: 1, seq: 1 }, 'request'), event);
    assert.ok(!JSON.stringify([body, published, raw]).includes('CANARY'));
    assert.equal(promptSettled, false);
    const post = await fetch(base + '/api/runtime/requests/' + pending.requestId, {
        method: 'POST', headers: auth, body: JSON.stringify({ ...originalBinding,
            response: { optionId: pending.view.fields[0].options[1].id } }),
    });
    assert.deepEqual(await post.json(), { ok: true, data: { accepted: true } });
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.deepEqual(f.writes[1], { jsonrpc: '2.0', id: prompt.id,
        result: { outcome: { outcome: 'selected', optionId: 'CANARY_NATIVE_ALLOW' } } });
    assert.equal(f.writes.length, 2);
    assert.equal(promptSettled, false);
    f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } }) + '\n');
    assert.deepEqual(await prompt.result, { stopReason: 'end_turn' });
    assert.ok(!JSON.stringify([published, raw]).includes('CANARY'));
});

test('actual routes enforce supplied auth, body shape, exact binding and private handle membership', { timeout: 5000 }, async t => {
    const f = fixture(t);
    const base = await serve(t, f.registry);
    f.request('peer');
    const pending = f.registry.list('chat')[0]!;
    const url = base + '/api/runtime/requests/' + pending.requestId;
    const valid = { ...originalBinding, response: { optionId: pending.view.fields[0]!.options[1]!.id } };
    assert.equal((await fetch(base + '/api/runtime/requests?sessionId=chat')).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid) })).status, 401);
    for (const query of ['', '?sessionId=', '?sessionId=chat&sessionId=other', '?sessionId=' + 'x'.repeat(241)]) {
        assert.equal((await fetch(base + '/api/runtime/requests' + query, { headers: auth })).status, 400);
    }
    assert.deepEqual(await (await fetch(base + '/api/runtime/requests?sessionId=other', { headers: auth })).json(), { ok: true, data: { requests: [] } });
    for (const value of [{ ...valid, extra: true }, [], { ...valid, response: { optionId: 'CANARY_NATIVE_ALLOW' } },
        { ...originalBinding }, { ...valid, runId: '' }, { ...valid, response: { optionId: null, grant: true } }]) {
        assert.equal((await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(value) })).status, 400);
    }
    for (const key of ['runId', 'sessionId', 'scope', 'turnId']) {
        assert.equal((await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ ...valid, [key]: 'foreign' }) })).status, 409);
    }
    assert.equal(f.writes.length, 0);
    assert.equal(f.registry.list('chat').length, 1);
    assert.equal((await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(valid) })).status, 200);
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.equal((await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(valid) })).status, 409);
    assert.equal(f.writes.length, 1);
});

test('auto uses protocol kinds and nullable titles without opening requests', { timeout: 5000 }, async t => {
    const f = fixture(t, 'auto');
    f.request(1, { ...params(), toolCall: { toolCallId: 'tool', title: null } });
    await f.waitFor(() => f.writes.length === 1);
    assert.equal(f.writes[0]!.result.outcome.optionId, 'CANARY_NATIVE_ALLOW');
    assert.deepEqual(f.registry.list('chat'), []);
    assert.deepEqual(published, []);
});

for (const mode of ['safe', [], ['auto']] as const) test(`restrictive policy ${JSON.stringify(mode)} waits and cancels`, { timeout: 5000 }, async t => {
    const f = fixture(t, mode);
    f.request('peer');
    assert.equal(f.writes.length, 0);
    assert.equal(f.registry.list('chat').length, 1);
    f.callbacks.cancelRun('run');
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.equal(f.writes[0]!.result.outcome.outcome, 'cancelled');
});

for (const dispose of [false, true]) test(`respond then ${dispose ? 'dispose' : 'cancelRun'} cannot admit a selected reply`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    f.request('peer');
    respond(f);
    if (dispose) f.callbacks.dispose(); else f.callbacks.cancelRun('run');
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.ok(f.writes.every(write => write.result?.outcome?.outcome !== 'selected'));
    if (!dispose) assert.equal(f.writes[0]!.result.outcome.outcome, 'cancelled');
});
for (const dispose of [false, true]) test(`final ownership predicate may ${dispose ? 'dispose' : 'cancel'} without admitting selected`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    let armed = false;
    f.owner!.isCurrent = () => {
        if (armed) { armed = false; if (dispose) f.callbacks.dispose(); else f.callbacks.cancelRun('run'); }
        return true;
    };
    f.request('peer'); respond(f); armed = true;
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.ok(f.writes.every(write => write.result?.outcome?.outcome !== 'selected'));
});
for (const throws of [false, true]) test(`publication ${throws ? 'throw' : 'null'} after resolving an answer still cancels`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    const emit = f.owner!.emit;
    f.owner!.emit = body => {
        if (body.kind === 'request') {
            respond(f);
            if (throws) throw new Error('private-publish-failure');
            return null;
        }
        return emit(body);
    };
    f.request('peer');
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.equal(f.writes[0]!.result.outcome.outcome, 'cancelled');
});

test('failed reply closes the connection and settles other pending callbacks without unhandled errors', { timeout: 5000 }, async t => {
    const f = fixture(t); f.request('first'); f.request('second'); f.failWrites(); respond(f);
    await f.waitFor(() => f.attempts.filter(e => e.kind === 'request-settled').length === 2);
    assert.equal(f.connection.alive, false);
    assert.equal(f.failures.length, 1);
    assert.deepEqual(f.registry.list('chat'), []);
    assert.ok(!JSON.stringify(f.failures.map(e => e.message)).includes('private-write-error'));
});

test('cancelling an admitted selected reply retires the connection without claiming bytes were unsent', { timeout: 5000 }, async t => {
    const f = fixture(t);
    f.request('peer'); f.hold(); respond(f);
    await f.waitFor(() => f.writes.length === 1);
    assert.equal(f.writes[0]!.result.outcome.outcome, 'selected'); // admitted before cancellation
    f.callbacks.cancelRun('run');
    assert.equal(f.connection.alive, false);
    f.release(); f.request('later');
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.equal(f.writes.length, 1);
    assert.equal(f.failures.length, 1);
});

test('current-run cancellation fences late callbacks and an older cancellation cannot unlock a newer run', { timeout: 5000 }, async t => {
    const f = fixture(t, 'auto');
    f.callbacks.cancelRun('run'); f.request('old');
    await f.waitFor(() => f.writes.length === 1);
    assert.equal(f.writes[0]!.result.outcome.outcome, 'cancelled');
    f.setOwner('new'); f.request('new-normal');
    await f.waitFor(() => f.writes.length === 2);
    assert.equal(f.writes[1]!.result.outcome.outcome, 'selected');
    await new Promise<void>(resolve => setImmediate(resolve)); // already-observed write bookkeeping
    f.callbacks.cancelRun('new'); f.callbacks.cancelRun('run'); f.request('new-cancelled');
    await f.waitFor(() => f.writes.length === 3);
    assert.equal(f.writes[2]!.result.outcome.outcome, 'cancelled');
});

test('lost ownership converts an already-recorded decision into cancellation', { timeout: 5000 }, async t => {
    const f = fixture(t); f.request('peer'); respond(f); f.loseOwner();
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.equal(f.writes[0]!.result.outcome.outcome, 'cancelled');
});

test('expired permission replies with cancellation exactly once', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const f = fixture(t); f.request('peer');
    t.mock.timers.tick(120_000);
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.equal(f.writes[0]!.result.outcome.outcome, 'cancelled');
    assert.deepEqual(f.registry.list('chat'), []);
});

test('publication failure cancels the invisible request and releases private mapping', { timeout: 5000 }, async t => {
    appendFails = true;
    const f = fixture(t); f.request('peer');
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.equal(f.writes[0]!.result.outcome.outcome, 'cancelled');
    assert.deepEqual(f.registry.list('chat'), []);
    assert.deepEqual(published, []);
});

test('32 callbacks fit and the next receives an error without another pending view', { timeout: 5000 }, async t => {
    const f = fixture(t);
    for (let id = 0; id < 33; id++) f.request(id);
    await f.waitFor(() => f.writes.length === 1);
    assert.equal(f.writes[0]!.id, 32);
    assert.equal(f.writes[0]!.error.code, -32000);
    assert.equal(f.registry.list('chat').length, 32);
    f.callbacks.cancelRun('run');
    await f.waitFor(() => f.attempts.filter(e => e.kind === 'request-settled').length === 32);
    assert.equal(f.writes.length, 33);
    assert.ok(f.writes.slice(1).every(write => write.result.outcome.outcome === 'cancelled'));
});

test('duplicate peer ID retires instead of later sending a successful duplicate response', { timeout: 5000 }, async t => {
    const f = fixture(t); f.request('duplicate'); f.request('duplicate');
    await f.waitFor(() => !f.connection.alive);
    assert.equal(f.failures.length, 1);
    assert.ok(f.writes.every(write => write.result?.outcome?.outcome !== 'selected'));
    assert.deepEqual(f.registry.list('chat'), []);
});

test('unsupported host operations and malformed permission params only receive fixed errors', { timeout: 5000 }, async t => {
    const f = fixture(t);
    const methods = ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output',
        'terminal/wait_for_exit', 'terminal/kill', 'terminal/release', 'cursor/ask_question', 'cursor/create_plan'];
    methods.forEach((method, id) => f.request(id, { sessionId: 'native', path: '/private/not-opened' }, method));
    f.request('bad', { ...params(), sessionId: 'foreign' });
    await f.waitFor(() => f.writes.length === 10);
    assert.ok(f.writes.slice(0, 9).every(write => write.error.code === -32601));
    assert.equal(f.writes[9]!.error.code, -32602);
    assert.deepEqual(f.registry.list('chat'), []);
    assert.deepEqual(published, []);
    assert.ok(!JSON.stringify(f.writes).includes('/private/'));
});

test('no owner refuses requests; throwing owner resolver retires safely', { timeout: 5000 }, async t => {
    const f = fixture(t); f.setOwner(null); f.request('missing');
    await f.waitFor(() => f.writes.length === 1);
    assert.equal(f.writes[0]!.error.code, -32600);
    f.breakResolver(); f.request('broken');
    assert.equal(f.connection.alive, false);
    assert.equal(f.failures[0]!.message, 'acp_callback_owner_failed');
});

test('caller binding mutation cannot retag the captured request or settlement', { timeout: 5000 }, async t => {
    const f = fixture(t); f.request('peer');
    f.owner!.binding.turnId = 'replacement';
    respond(f);
    await f.waitFor(() => f.attempts.some(e => e.kind === 'request-settled'));
    assert.ok(published.every(event => event.turnId === 'turn'));
    assert.equal(f.writes[0]!.result.outcome.outcome, 'selected');
});

test('drain waits for actual writes after registry settlement and for no-owner refusals', { timeout: 5000 }, async t => {
    const f = fixture(t); f.request('peer'); f.hold(); respond(f);
    await f.waitFor(() => f.writes.length === 1);
    assert.deepEqual(f.registry.list('chat'), []);
    let drained = false;
    const drain = f.callbacks.drain('run').then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    f.release(); await drain;
    assert.equal(drained, true);
    f.setOwner(null); f.request('no-owner');
    await f.waitFor(() => f.writes.length === 2);
    drained = false;
    const refusal = f.callbacks.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    f.release(); await refusal;
    assert.equal(drained, true);
});
test('drain rejects retired or failed callback work rather than authorizing reuse', { timeout: 5000 }, async t => {
    const f = fixture(t); f.request('peer'); f.failWrites(); respond(f);
    await assert.rejects(f.callbacks.drain('run'), /acp_callback/);
    assert.equal(f.connection.alive, false);
    await assert.rejects(f.callbacks.drain(), /acp_callbacks_closed/);
});
