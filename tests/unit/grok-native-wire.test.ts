import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpSession, type AcpNotificationConsumer, type AcpTurnOwner, type AcpSessionOptions } from '../../src/agent/runtime/acp/session.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import { GrokReplacement, GrokReplacementError } from '../../src/agent/runtime/acp/grok-control.ts';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Wire = { id?: string; method?: string; params?: unknown };
type PromptOptions = { onDispatched?: () => void };

async function fixture(t: TestContext, overrides: Partial<AcpSessionOptions> = {}) {
    const writes: Wire[] = [], failures: string[] = [], kills: string[] = [];
    let heldWrite: ((error?: Error | null) => void) | undefined;
    const child = Object.assign(new EventEmitter(), { pid: 48001, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    const feed = (...frames: unknown[]) => child.stdout.write(frames.map(frame => JSON.stringify(frame) + '\n').join(''));
    child.stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk)) as Wire;
        writes.push(frame);
        if (frame.method === 'session/prompt') { heldWrite = done; return; }
        if (frame.method === 'initialize') feed({ jsonrpc: '2.0', id: frame.id,
            result: { protocolVersion: 1, agentCapabilities: {} } });
        if (frame.method === 'session/new') feed({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'grok-native' } });
        done();
    } });
    const exit = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 143; child.emit('exit', 143, null); child.emit('close', 143, null);
    };
    // Only the process boundary is faked: session, framing, writes and notification drain are real.
    const session = new AcpSession(child as unknown as ChildProcessWithoutNullStreams, {
        permissions: 'auto', promptTimeoutMs: 2000, requestTimeoutMs: 2000,
        controlTimeoutMs: 2000, drainTimeoutMs: 2000, registry: new RuntimeRequests(),
        ownedProcessOptions: { terminateTree: (_pid, signal) => { kills.push(signal ?? 'SIGTERM'); queueMicrotask(exit); } },
        failed: error => failures.push(error.message),
        ...overrides,
    });
    t.after(async () => { await session.close(); heldWrite?.(); });
    const owner: AcpTurnOwner = { binding: { runId: 'run', sessionId: 'chat', scope: 'scope', turnId: 'turn' },
        isCurrent: () => true, emit: () => null };
    const parts = [{ type: 'text', text: 'wire probe' }];
    const prompt = (options?: PromptOptions, consume: AcpNotificationConsumer = () => {}) => {
        const result = session.prompt(parts, owner, consume, options);
        void result.catch(() => undefined);
        return result;
    };
    const resultFrame = (stopReason = 'end_turn') => {
        const request = writes.findLast(frame => frame.method === 'session/prompt');
        assert.ok(request?.id);
        return { jsonrpc: '2.0', id: request.id, result: { stopReason } };
    };
    const update = () => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-native',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'admitted' } } } });
    const finishWrite = (error?: Error) => {
        assert.ok(heldWrite, 'prompt write must be held');
        const done = heldWrite; heldWrite = undefined; done(error);
    };
    await session.start({ cwd: process.cwd() });
    return { session, child, owner, parts, prompt, writes, failures, kills, feed, resultFrame, update, finishWrite };
}

test('dispatch observer waits for the stdin write callback and does not wait for the RPC result', { timeout: 5000 }, async t => {
    const f = await fixture(t); let observed = 0, settled = false;
    const result = f.prompt({ onDispatched: () => { observed++; } });
    void result.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    assert.equal(observed, 0); assert.equal(settled, false);
    assert.equal(f.writes.filter(frame => frame.method === 'session/prompt').length, 1);
    f.finishWrite(); await tick();
    assert.equal(observed, 1); assert.equal(settled, false);
    f.feed(f.resultFrame());
    assert.deepEqual(await result, { stopReason: 'end_turn' });
    assert.equal(observed, 1); assert.equal(f.session.idle, true);
});

test('an original result before write completion still reports the dispatch exactly once', { timeout: 5000 }, async t => {
    const f = await fixture(t); let observed = 0, settled = false;
    const result = f.prompt({ onDispatched: () => { observed++; } });
    void result.then(() => { settled = true; }, () => { settled = true; });
    f.feed(f.resultFrame()); await tick();
    assert.equal(observed, 0); assert.equal(settled, false); assert.equal(f.session.idle, false);
    f.finishWrite();
    assert.deepEqual(await result, { stopReason: 'end_turn' });
    assert.equal(observed, 1);
    f.feed(f.resultFrame()); await tick();
    assert.equal(observed, 1); assert.equal(f.session.idle, true);
});

test('cancel before write completion preserves the dispatch fact and waits for original result and drain', { timeout: 5000 }, async t => {
    const f = await fixture(t), entered = deferred(), drain = deferred();
    let observed = 0, cancelled = false, settled = false;
    t.after(() => drain.resolve());
    const result = f.prompt({ onDispatched: () => { observed++; } }, async () => { entered.resolve(); await drain.promise; });
    void result.then(() => { settled = true; }, () => { settled = true; });
    f.feed(f.update()); await entered.promise;
    const cancellation = f.session.cancel();
    void cancellation.then(() => { cancelled = true; }, () => {});
    f.owner.isCurrent = () => false;
    await tick();
    assert.equal(observed, 0); assert.equal(cancelled, false);
    assert.equal(f.writes.some(frame => frame.method === 'session/cancel'), false);
    f.finishWrite(); await tick();
    assert.equal(observed, 1); assert.equal(cancelled, false); assert.equal(settled, false);
    assert.equal(f.writes.filter(frame => frame.method === 'session/cancel').length, 1);
    f.feed(f.resultFrame('cancelled')); await tick();
    assert.equal(cancelled, false); assert.equal(settled, false); assert.equal(f.session.idle, false);
    drain.resolve(); await cancellation;
    assert.deepEqual(await result, { stopReason: 'cancelled' });
    assert.equal(observed, 1); assert.equal(f.session.idle, true);
});

test('observer is captured before owner admission and cannot be retargeted while the write is held', { timeout: 5000 }, async t => {
    const f = await fixture(t); const calls: string[] = [];
    const options = { onDispatched: () => { calls.push('original'); } };
    f.owner.isCurrent = () => { options.onDispatched = () => { calls.push('admission mutation'); }; return true; };
    const result = f.prompt(options);
    options.onDispatched = () => { calls.push('held mutation'); };
    f.finishWrite(); f.feed(f.resultFrame());
    await result;
    assert.deepEqual(calls, ['original']);
});

for (const earlyResult of [false, true]) test(`observer exceptions retire with a fixed error (early result: ${earlyResult})`, { timeout: 5000 }, async t => {
    const f = await fixture(t); let observed = 0;
    const result = f.prompt({ onDispatched: () => { observed++; throw new Error('private-observer-payload'); } });
    const rejected = assert.rejects(result, { message: 'acp_dispatch_observer_failed' });
    if (earlyResult) f.feed(f.resultFrame());
    f.finishWrite(); await rejected;
    assert.equal(observed, 1); assert.equal(f.session.alive, false); assert.equal(f.session.idle, false);
    assert.deepEqual(f.failures, ['acp_dispatch_observer_failed']); assert.equal(f.kills.length, 1);
    await assert.rejects(f.prompt(), /acp_prompt_unavailable/);
    assert.equal(f.writes.filter(frame => frame.method === 'session/prompt').length, 1);
    await f.session.close(); assert.equal(f.child.exitCode, 143);
});

for (const earlyResult of [false, true]) test(`write failure never invokes the observer (early result: ${earlyResult})`, { timeout: 5000 }, async t => {
    const f = await fixture(t); let observed = 0;
    const result = f.prompt({ onDispatched: () => { observed++; } });
    const rejected = assert.rejects(result, { message: 'acp_write_failed' });
    if (earlyResult) f.feed(f.resultFrame());
    f.finishWrite(new Error('private-write-payload')); await rejected;
    assert.equal(observed, 0); assert.equal(f.session.alive, false); assert.equal(f.kills.length, 1);
});

for (const rejects of [false, true]) test(`async dispatch observers are rejected without delaying the RPC fence (rejects: ${rejects})`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const observation = rejects ? Promise.reject(new Error('private async observer')) : Promise.resolve();
    void observation.catch(() => undefined); // Observe the deliberately rejected fixture promise during RED too.
    const result = f.prompt({ onDispatched: () => observation });
    const rejected = assert.rejects(result, { message: 'acp_dispatch_observer_failed' });
    f.finishWrite(); f.feed(f.resultFrame()); await rejected;
    assert.equal(f.session.alive, false); assert.equal(f.kills.length, 1);
});

test('retirement before a completed write never invokes the observer, including a late write callback', { timeout: 5000 }, async t => {
    const f = await fixture(t); let observed = 0;
    const result = f.prompt({ onDispatched: () => { observed++; } });
    const rejected = assert.rejects(result, { message: 'acp_retired' });
    f.session.retire(); await rejected;
    f.finishWrite(); await tick();
    assert.equal(observed, 0); assert.equal(f.kills.length, 1);
});

for (const lateKind of ['content', 'permission'] as const) test(`result fences the next ${lateKind} frame even before dispatch observer continuation`, { timeout: 5000 }, async t => {
    const f = await fixture(t); let observed = 0, consumed = 0;
    const result = f.prompt({ onDispatched: () => { observed++; } }, () => { consumed++; });
    const code = lateKind === 'content' ? 'acp_content_without_active_turn' : 'acp_request_after_terminal';
    const rejected = assert.rejects(result, { message: code });
    f.finishWrite();
    const late = lateKind === 'content' ? f.update() : { jsonrpc: '2.0', id: 'late-human',
        method: 'session/request_permission', params: { sessionId: 'grok-native', options: [] } };
    f.feed(f.resultFrame(), late);
    assert.equal(f.session.alive, false); // The response observer seals synchronously within this stdout chunk.
    await rejected;
    assert.equal(observed, 1); assert.equal(consumed, 0); assert.deepEqual(f.failures, [code]);
    assert.equal(f.writes.some(frame => frame.id === 'late-human'), false);
});

test('non-function observers are rejected before admission without retiring the reusable owner', { timeout: 5000 }, async t => {
    const f = await fixture(t); const count = f.writes.length;
    for (const onDispatched of [null, false, 1, 'callback', {}]) {
        // Deliberately violate the TypeScript boundary to exercise runtime admission validation.
        await assert.rejects(f.prompt({ onDispatched: onDispatched as unknown as () => void }),
            { message: 'acp_invalid_dispatch_observer' });
        assert.equal(f.writes.length, count); assert.equal(f.session.idle, true);
    }
    assert.deepEqual(f.failures, []); assert.equal(f.kills.length, 0);
});

test('three-argument callers and an omitted observer retain normal completion and reuse', { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const first = f.session.prompt(f.parts, f.owner, () => {});
    f.finishWrite(); f.feed(f.resultFrame());
    assert.deepEqual(await first, { stopReason: 'end_turn' });
    const second = f.prompt({}); f.finishWrite(); f.feed(f.resultFrame());
    assert.deepEqual(await second, { stopReason: 'end_turn' });
    assert.equal(f.session.idle, true); assert.equal(f.session.nativeSessionId, 'grok-native');
});

test('dispatch observer can synchronously cancel without deadlocking the original result', { timeout: 5000 }, async t => {
    const f = await fixture(t); let observed = 0, cancellation: Promise<void> | undefined;
    const result = f.prompt({ onDispatched: () => { observed++; cancellation = f.session.cancel(); } });
    f.finishWrite(); await tick();
    assert.equal(observed, 1); assert.ok(cancellation);
    assert.equal(f.writes.filter(frame => frame.method === 'session/cancel').length, 1);
    f.feed(f.resultFrame('cancelled')); await cancellation;
    assert.deepEqual(await result, { stopReason: 'cancelled' });
    assert.equal(f.session.idle, true); assert.equal(observed, 1);
});

function wireControl(f: Awaited<ReturnType<typeof fixture>>, consume: (epoch: number, frame: unknown) => void | Promise<void> = () => {}) {
    const results: Array<Promise<Record<string, unknown>>> = [], dispatches: number[] = [];
    const settlements: Array<{ epoch: number; stopReason: unknown; pending: boolean }> = [];
    let current: Promise<Record<string, unknown>> | undefined;
    const control = new GrokReplacement({
        start(prompt, epoch) {
            let resolve!: () => void, reject!: (error: unknown) => void;
            const dispatched = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
            current = f.session.prompt([{ type: 'text', text: prompt.text }], f.owner,
                frame => consume(epoch, frame), { onDispatched: () => { dispatches.push(epoch); resolve(); } });
            results.push(current);
            void current.then(result => { settlements.push({ epoch, stopReason: result['stopReason'], pending: control.hasPendingReplacement }); }, reject);
            return dispatched;
        },
        async cancelAndDrain() {
            const original = current;
            await f.session.cancel();
            if (original) await original;
            assert.equal(f.session.idle, true, 'replacement waits the original prompt finally, not cancel() alone');
        },
        retire(error) { f.session.retire(error); },
    });
    return { control, results, dispatches, settlements };
}

test('controller and real ACP wire order cancel, original terminal/drain and replacement dispatch', { timeout: 5000 }, async t => {
    const f = await fixture(t), entered = deferred(), drained = deferred(), consumed: number[] = [];
    t.after(() => drained.resolve());
    const h = wireControl(f, async epoch => {
        if (epoch === 1) { entered.resolve(); await drained.promise; }
        consumed.push(epoch);
    });
    const first = h.control.first({ text: 'A' }); await tick();
    const original = f.resultFrame('cancelled');
    f.finishWrite(); await first;
    f.feed(f.update()); await entered.promise;
    const replacement = h.control.replace({ text: 'B' }); await tick();
    assert.equal(f.writes.filter(frame => frame.method === 'session/cancel').length, 1);
    f.feed({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { sessionId: 'grok-native', stopReason: 'cancelled' } }, original);
    await tick(); assert.equal(f.writes.filter(frame => frame.method === 'session/prompt').length, 1);
    assert.equal(h.control.currentEpoch, 1);
    drained.resolve(); await tick();
    const requests = f.writes.filter(frame => frame.method === 'session/prompt');
    assert.equal(requests.length, 2); assert.notEqual(requests[0]!.id, requests[1]!.id);
    assert.deepEqual(requests[1]!.params, { sessionId: 'grok-native', prompt: [{ type: 'text', text: 'B' }] });
    assert.deepEqual(consumed, [1]); assert.deepEqual(h.dispatches, [1]);
    assert.deepEqual(h.settlements[0], { epoch: 1, stopReason: 'cancelled', pending: true });
    f.feed({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { sessionId: 'grok-native', promptId: 'old-A', stopReason: 'end_turn' } });
    f.finishWrite(); assert.deepEqual(await replacement, { accepted: true, epoch: 2 });
    assert.deepEqual(h.dispatches, [1, 2]);
    f.feed(f.update(), f.resultFrame()); await h.results[1];
    assert.deepEqual(consumed, [1, 2]); assert.equal(h.settlements[1]!.pending, false);
});

test('controller starts the real cancellation deadline while stdin is held and never dispatches B after timeout', { timeout: 5000 }, async t => {
    const f = await fixture(t, { promptTimeoutMs: 20_000, controlTimeoutMs: 100 });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = wireControl(f), first = h.control.first({ text: 'A' }); await tick();
    const replacement = h.control.replace({ text: 'B' });
    const a = assert.rejects(first, GrokReplacementError), b = assert.rejects(replacement, GrokReplacementError);
    t.mock.timers.tick(100); await Promise.all([a, b]);
    assert.deepEqual(f.failures, ['acp_cancel_timeout']);
    assert.equal(f.writes.filter(frame => frame.method === 'session/prompt').length, 1);
    assert.deepEqual(h.dispatches, []); assert.equal(h.control.currentEpoch, 1);
    assert.equal(f.kills.length, 1); assert.equal(f.session.alive, false);
    await f.session.close(); assert.equal(f.child.exitCode, 143);
});
