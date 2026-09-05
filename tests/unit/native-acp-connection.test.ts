import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpConnection } from '../../src/agent/runtime/acp/connection.ts';
import { decodeFrame, type RpcFrame } from '../../src/agent/runtime/acp/wire.ts';

const FRAME_LIMIT = 4 * 1024 * 1024;
type Callback = (error?: Error | null) => void;
function fixture(t: TestContext, options: {
    hold?: boolean; writeError?: boolean; writeThrow?: boolean;
    frame?: (frame: RpcFrame) => void; failed?: () => void;
} = {}) {
    const frames: RpcFrame[] = [], failures: Error[] = [], writes: string[] = [], callbacks: Callback[] = [];
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
            writes.push(String(chunk));
            if (options.writeThrow) throw new Error('sensitive-write-exception');
            if (options.hold) callbacks.push(callback);
            else callback(options.writeError ? new Error('sensitive-EPIPE') : undefined);
        } }),
    });
    const connection = new AcpConnection(child as unknown as ChildProcessWithoutNullStreams, {
        frame: frame => { frames.push(frame); options.frame?.(frame); },
        failed: error => { failures.push(error); options.failed?.(); },
    });
    t.after(() => {
        connection.close();
        for (const callback of callbacks.splice(0)) callback();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    });
    return { connection, child, frames, failures, writes, callbacks,
        feed: (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n') };
}
function frameOfSize(size: number): RpcFrame {
    const frame = { jsonrpc: '2.0' as const, method: 'session/update', params: '' };
    frame.params = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(frame)));
    return frame;
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('reassembles split UTF-8 bytes, CRLF, blank lines and coalesced frames', t => {
    const f = fixture(t);
    const frame = { jsonrpc: '2.0', method: 'session/update', params: { text: '한글 🌱' } };
    const bytes = Buffer.from(JSON.stringify(frame) + '\r\n');
    for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
    f.child.stdout.write('\n \r\n' + JSON.stringify(frame) + '\n' + JSON.stringify(frame) + '\n');
    assert.deepEqual(f.frames, [frame, frame, frame]);
    assert.equal(f.connection.alive, true);
});

test('fragmented carry handles tiny chunks without changing content', t => {
    const f = fixture(t);
    const frame = frameOfSize(65_536);
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    for (let i = 0; i < bytes.length; i++) f.child.stdout.emit('data', bytes.subarray(i, i + 1));
    assert.deepEqual(f.frames, [frame]);
});

const invalidFrames = [
    ['json', '{"secret":"private-frame-sentinel"'], ['scalar', 'true'], ['batch', '[]'],
    ['version', '{"jsonrpc":"1.0","method":"event"}'],
    ['null id', '{"jsonrpc":"2.0","id":null,"result":null}'],
    ['fractional id', '{"jsonrpc":"2.0","id":1.2,"result":null}'],
    ['unsafe id', '{"jsonrpc":"2.0","id":9007199254740993,"result":null}'],
    ['empty method', '{"jsonrpc":"2.0","method":""}'],
    ['method and result', '{"jsonrpc":"2.0","id":1,"method":"event","result":null}'],
    ['missing id', '{"jsonrpc":"2.0","result":null}'],
    ['missing result', '{"jsonrpc":"2.0","id":1}'],
    ['ambiguous response', '{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":1,"message":"x"}}'],
    ['malformed error', '{"jsonrpc":"2.0","id":1,"error":{"code":"bad","message":"private-frame-sentinel"}}'],
] as const;
for (const [label, line] of invalidFrames) test(`invalid ${label} retires pending work without exposing payload`, async t => {
    const f = fixture(t);
    const request = f.connection.request('session/prompt', {});
    await request.dispatched;
    f.child.stdout.write(line + '\n');
    await assert.rejects(request.result, /^Error: acp_invalid_/);
    assert.equal(f.connection.alive, false);
    assert.equal(f.failures.length, 1);
    assert.ok(!f.failures[0]!.message.includes('private-frame-sentinel'));
    assert.equal(f.child.stdout.listenerCount('data'), 0);
});

test('invalid UTF-8 fails closed instead of replacement-character decoding', t => {
    const f = fixture(t);
    f.child.stdout.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 10]));
    assert.equal(f.failures[0]?.message, 'acp_invalid_utf8');
    assert.equal(f.frames.length, 0);
});

for (const partial of [false, true]) test(`stdout EOF ${partial ? 'with incomplete frame' : 'without frame'} settles requests`, async t => {
    const f = fixture(t);
    const request = f.connection.request('session/prompt', {});
    await request.dispatched;
    if (partial) f.child.stdout.write('{"jsonrpc":');
    f.child.stdout.end();
    await assert.rejects(request.result, partial ? /acp_truncated_frame/ : /acp_stdout_end/);
    assert.equal(f.failures.length, 1);
});

test('exact frame limit is accepted inbound and outbound', async t => {
    const f = fixture(t);
    const frame = frameOfSize(FRAME_LIMIT);
    f.feed(frame);
    assert.deepEqual(f.frames, [frame]);
    await f.connection.write(frame);
    assert.equal(Buffer.byteLength(f.writes[0]!), FRAME_LIMIT + 1);
    assert.equal(f.connection.alive, true);
});
for (const split of [false, true]) test(`exact-limit CRLF payload is accepted ${split ? 'across delimiter chunks' : 'in one chunk'}`, t => {
    const f = fixture(t);
    const frame = frameOfSize(FRAME_LIMIT);
    if (split) {
        f.child.stdout.write(JSON.stringify(frame));
        f.child.stdout.write('\r');
        f.child.stdout.write('\n');
    } else f.child.stdout.write(JSON.stringify(frame) + '\r\n');
    assert.equal(f.connection.alive, true);
    assert.deepEqual(f.frames, [frame]);
});
test('CRLF does not permit a payload byte beyond the limit', t => {
    const f = fixture(t);
    f.child.stdout.write(JSON.stringify(frameOfSize(FRAME_LIMIT + 1)) + '\r\n');
    assert.equal(f.failures[0]?.message, 'acp_frame_limit');
    assert.equal(f.frames.length, 0);
});
for (const newline of [false, true]) test(`oversized ${newline ? 'complete' : 'incomplete'} input fails before delivery`, t => {
    const f = fixture(t);
    f.child.stdout.write(Buffer.from('x'.repeat(FRAME_LIMIT + 1) + (newline ? '\n' : '')));
    assert.equal(f.failures[0]?.message, 'acp_frame_limit');
    assert.equal(f.frames.length, 0);
});
test('fragmented input crossing the limit retires and drops the remainder', t => {
    const f = fixture(t);
    f.child.stdout.write(Buffer.alloc(FRAME_LIMIT, 32));
    assert.equal(f.connection.alive, true);
    f.child.stdout.write('x\n{"jsonrpc":"2.0","method":"never"}\n');
    assert.equal(f.failures[0]?.message, 'acp_frame_limit');
    assert.equal(f.frames.length, 0);
});

test('peer callbacks and updates interleave with a pending prompt despite equal IDs', async t => {
    const replies: Promise<void>[] = [];
    const f = fixture(t, { frame(frame) {
        if ('method' in frame && 'id' in frame) replies.push(f.connection.reply(frame.id, { accepted: true }));
    } });
    const request = f.connection.request('session/prompt', {});
    await request.dispatched;
    let finished = false;
    void request.result.then(() => { finished = true; });
    f.feed({ jsonrpc: '2.0', id: request.id, method: 'session/request_permission', params: {} });
    f.feed({ jsonrpc: '2.0', method: 'session/update', params: { text: 'pending' } });
    await Promise.all(replies);
    assert.equal(finished, false);
    assert.equal(f.frames.length, 2);
    assert.deepEqual(JSON.parse(f.writes[1]!), { jsonrpc: '2.0', id: request.id, result: { accepted: true } });
    f.feed({ jsonrpc: '2.0', id: request.id, result: null });
    assert.equal(await request.result, null);
    f.feed({ jsonrpc: '2.0', id: request.id, result: 'duplicate' });
    f.feed({ jsonrpc: '2.0', id: 'unknown', result: 'late' });
    assert.equal(f.frames.length, 2);
});

test('RPC error rejects only that request with code-only diagnostics', async t => {
    const f = fixture(t);
    const a = f.connection.request('a', {}), b = f.connection.request('b', {});
    await Promise.all([a.dispatched, b.dispatched]);
    f.feed({ jsonrpc: '2.0', id: a.id, error: { code: -32001, message: 'private-frame-sentinel', data: { token: 'private' } } });
    await assert.rejects(a.result, { message: 'acp_rpc_error:-32001' });
    assert.equal(f.connection.alive, true);
    f.feed({ jsonrpc: '2.0', id: b.id, result: { ok: true } });
    assert.deepEqual(await b.result, { ok: true });
});

test('64 pending requests are admitted; the next rejects without corrupting them', async t => {
    const f = fixture(t);
    const requests = Array.from({ length: 64 }, () => f.connection.request('probe', {}));
    assert.throws(() => f.connection.request('overflow', {}), /acp_unavailable/);
    await Promise.all(requests.map(r => r.dispatched));
    assert.equal(f.connection.alive, true);
    for (const request of requests) f.feed({ jsonrpc: '2.0', id: request.id, result: request.id });
    assert.deepEqual(await Promise.all(requests.map(r => r.result)), requests.map(r => r.id));
});
test('invalid request timeout does not write or retire a valid connection', t => {
    const f = fixture(t);
    for (const ms of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
        assert.throws(() => f.connection.request('probe', {}, ms), /acp_invalid_timeout/);
    }
    assert.equal(f.writes.length, 0);
    assert.equal(f.connection.alive, true);
});

test('backpressure keeps FIFO cancel before replacement without a cancel request ID', async t => {
    const f = fixture(t, { hold: true });
    const cancel = f.connection.notify('session/cancel', { sessionId: 'fixture' });
    const next = f.connection.request('session/prompt', { prompt: 'next' });
    let dispatched = false;
    void next.dispatched.then(() => { dispatched = true; });
    await Promise.resolve();
    assert.equal(f.writes.length, 1);
    assert.equal(dispatched, false);
    assert.equal(Object.hasOwn(JSON.parse(f.writes[0]!), 'id'), false);
    f.callbacks.shift()!();
    await cancel;
    assert.equal(f.writes.length, 2);
    f.callbacks.shift()!();
    await next.dispatched;
    assert.equal(JSON.parse(f.writes[1]!).method, 'session/prompt');
    f.feed({ jsonrpc: '2.0', id: next.id, result: { stopReason: 'end_turn' } });
    await next.result;
});

test('request timeout rejects active and queued writes once; late callbacks cannot revive it', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { hold: true });
    const a = f.connection.request('session/prompt', {}, 50);
    const b = f.connection.request('initialize', {}, 500);
    t.mock.timers.tick(50);
    await Promise.all([a.dispatched, a.result, b.dispatched, b.result].map(p => assert.rejects(p, /acp_timeout/)));
    f.callbacks.shift()!();
    f.feed({ jsonrpc: '2.0', id: a.id, result: 'late' });
    f.child.emit('error', new Error('late')); f.child.emit('exit', 1, null);
    f.child.stdin.emit('error', new Error('late-EPIPE')); f.child.stdout.emit('error', new Error('late-read'));
    assert.equal(f.failures.length, 1);
    assert.equal(f.writes.length, 1);
    assert.throws(() => f.connection.request('never', {}), /acp_unavailable/);
    await assert.rejects(f.connection.notify('never', {}), /acp_closed/);
});

test('standalone and queued notification/reply writes have independent deadlines', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { hold: true });
    const a = f.connection.notify('session/cancel', {}), b = f.connection.reply('peer', null);
    t.mock.timers.tick(29_999);
    assert.equal(f.connection.alive, true);
    t.mock.timers.tick(1);
    await Promise.all([a, b].map(p => assert.rejects(p, /acp_write_timeout/)));
    assert.equal(f.failures.length, 1);
});
test('response before write callback does not remove the dispatch deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { hold: true });
    const request = f.connection.request('session/prompt', {}, 60_000);
    f.feed({ jsonrpc: '2.0', id: request.id, result: 'already completed' });
    assert.equal(await request.result, 'already completed');
    t.mock.timers.tick(30_000);
    await assert.rejects(request.dispatched, /acp_write_timeout/);
    assert.equal(await request.result, 'already completed');
    assert.equal(f.failures.length, 1);
});
test('queued write deadline starts on admission rather than when it becomes active', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { hold: true });
    const a = f.connection.notify('first', {});
    t.mock.timers.tick(10_000);
    const b = f.connection.notify('second', {});
    t.mock.timers.tick(10_000);
    f.callbacks.shift()!();
    await a;
    t.mock.timers.tick(19_999);
    assert.equal(f.connection.alive, true);
    t.mock.timers.tick(1);
    assert.equal(f.connection.alive, false);
    await assert.rejects(b, /acp_write_timeout/);
});

for (const mode of ['error', 'throw', 'exit', 'stdin', 'stdout', 'closed-stdin'] as const) {
    test(`${mode} before result await settles original promises without unhandled rejection`, async t => {
        const f = fixture(t, { hold: mode !== 'error' && mode !== 'throw', writeError: mode === 'error', writeThrow: mode === 'throw' });
        if (mode === 'closed-stdin') f.child.stdin.end();
        const request = f.connection.request('session/prompt', {});
        if (mode === 'exit') f.child.emit('exit', 1, null);
        if (mode === 'stdin' || mode === 'stdout') f.child[mode].emit('error', new Error('private-frame-sentinel'));
        await assert.rejects(request.dispatched, /^Error: acp_/);
        await tick(); // deliberately observe the original result one event-loop turn later
        await assert.rejects(request.result, /^Error: acp_/);
        assert.equal(f.failures.length, 1);
        assert.ok(!f.failures[0]!.message.includes('private-frame-sentinel'));
    });
}

test('8MiB queued-write byte boundary is exact and overflow settles all writes', async t => {
    const f = fixture(t, { hold: true });
    const frame = frameOfSize(FRAME_LIMIT - 1); // LF makes each write exactly4MiB
    const a = f.connection.write(frame), b = f.connection.write(frame);
    assert.equal(f.connection.alive, true);
    const c = f.connection.notify('overflow', {});
    await Promise.all([a, b, c].map(p => assert.rejects(p, /acp_write_limit/)));
    assert.equal(f.failures.length, 1);
    assert.equal(f.writes.length, 1);
});
test('1024 tiny queued writes fit; entry1025 retires them all', async t => {
    const f = fixture(t, { hold: true });
    const writes = Array.from({ length: 1024 }, () => f.connection.notify('event', {}));
    assert.equal(f.connection.alive, true);
    writes.push(f.connection.notify('overflow', {}));
    await Promise.all(writes.map(p => assert.rejects(p, /acp_write_limit/)));
    assert.equal(f.failures.length, 1);
});
test('oversized outgoing frame is rejected before touching stdin', async t => {
    const f = fixture(t);
    await assert.rejects(f.connection.write(frameOfSize(FRAME_LIMIT + 1)), /acp_write_limit/);
    assert.equal(f.writes.length, 0);
});

for (const value of [1n, (() => { const x: unknown[] = []; x.push(x); return x; })()]) {
    test('serialization failure settles a registered request without provider data in diagnostics', async t => {
        const f = fixture(t);
        const request = f.connection.request('session/prompt', value);
        await assert.rejects(request.dispatched, /acp_serialize_failed/);
        await tick();
        await assert.rejects(request.result, /acp_serialize_failed/);
        assert.equal(f.writes.length, 0);
        assert.equal(f.failures.length, 1);
    });
}
test('undefined result cannot serialize into a malformed outgoing response', async t => {
    const f = fixture(t);
    await assert.rejects(f.connection.reply('peer', undefined), /acp_invalid_outgoing_frame/);
    assert.equal(f.writes.length, 0);
});
test('root toJSON returning undefined retires all pending work with sanitized rejection', async t => {
    const f = fixture(t);
    const request = f.connection.request('session/prompt', {});
    await request.dispatched;
    const frame = { jsonrpc: '2.0' as const, id: 'peer', result: null, toJSON: () => undefined };
    await assert.rejects(async () => f.connection.write(frame), /acp_serialize_failed/);
    await assert.rejects(request.result, /acp_serialize_failed/);
    assert.equal(f.writes.length, 1);
    assert.equal(f.failures.length, 1);
});
test('serialization that closes the connection cannot admit a write after close', async t => {
    const f = fixture(t);
    const request = f.connection.request('session/prompt', { toJSON() { f.connection.close(); return {}; } });
    await assert.rejects(request.dispatched, /acp_closed/);
    await assert.rejects(request.result, /acp_closed/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.failures.length, 1);
});

test('frame hook close stops the rest of a coalesced chunk', t => {
    const f = fixture(t, { frame: () => f.connection.close() });
    f.child.stdout.write('{"jsonrpc":"2.0","method":"first"}\n{"jsonrpc":"2.0","method":"second"}\n');
    assert.equal(f.frames.length, 1);
    assert.equal(f.failures.length, 1);
});
test('throwing frame and failure hooks do not escape the transport handler', t => {
    const f = fixture(t, { frame: () => { throw new Error('private-frame-sentinel'); }, failed: () => { throw new Error('owner failed'); } });
    assert.doesNotThrow(() => f.feed({ jsonrpc: '2.0', method: 'event' }));
    assert.equal(f.failures[0]?.message, 'acp_frame_hook_failed');
    f.connection.close();
    assert.equal(f.failures.length, 1);
});
test('refusal preserves peer ID and error code on wire', async t => {
    const f = fixture(t);
    await f.connection.refuse(7, -32601, 'Unsupported method');
    assert.deepEqual(decodeFrame(f.writes[0]!), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Unsupported method' } });
});

test('matched response observer runs before the next frame in a coalesced chunk and before promise jobs', async t => {
    const order: string[] = [];
    const f = fixture(t, { frame: () => { order.push('notification'); } });
    const request = f.connection.request('session/prompt', {}, 1000, () => { order.push('response'); });
    await request.dispatched;
    const done = request.result.then(() => { order.push('promise'); });
    f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\n'
        + '{"jsonrpc":"2.0","method":"session/update"}\n');
    assert.deepEqual(order, ['response', 'notification']);
    await done;
    assert.deepEqual(order, ['response', 'notification', 'promise']);
});
test('unmatched and reentrant duplicate replies do not invoke the response observer twice', async t => {
    const f = fixture(t);
    let count = 0;
    const request = f.connection.request('session/prompt', {}, 1000, () => {
        count++;
        f.feed({ jsonrpc: '2.0', id: request.id, result: 'reentrant' });
    });
    await request.dispatched;
    f.feed({ jsonrpc: '2.0', id: 'unknown', result: null });
    assert.equal(count, 0);
    f.feed({ jsonrpc: '2.0', id: request.id, result: 'first' });
    assert.equal(await request.result, 'first');
    f.feed({ jsonrpc: '2.0', id: request.id, result: 'duplicate' });
    assert.equal(count, 1);
});
for (const throws of [false, true]) test(`response observer ${throws ? 'throw' : 'close'} rejects its still-registered request`, async t => {
    const f = fixture(t);
    const request = f.connection.request('session/prompt', {}, 1000, () => {
        if (throws) throw new Error('private observer text');
        f.connection.close();
    });
    const other = f.connection.request('other', {});
    await Promise.all([request.dispatched, other.dispatched]);
    f.feed({ jsonrpc: '2.0', id: request.id, result: null });
    await assert.rejects(request.result, throws ? /acp_response_observer_failed/ : /acp_closed/);
    await assert.rejects(other.result, /^Error: acp_/);
    assert.equal(f.failures.length, 1);
});
