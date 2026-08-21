import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createQueueNotice,
    QueueNoticeRegistry,
    type NoticeTransport,
} from '../../src/messaging/queue-notice.ts';

const EXPIRED = 'the queue timed out';

/** Records vendor calls so a branch can be proven to have fired — or not. */
function fakeTransport(overrides: Partial<NoticeTransport> = {}) {
    const calls: string[] = [];
    const seen: (AbortSignal | undefined)[] = [];
    const transport: NoticeTransport = {
        async delete(signal) { calls.push('delete'); seen.push(signal); },
        async edit(text, signal) { calls.push('edit:' + text); seen.push(signal); },
        ...overrides,
    };
    return { transport, calls, seen };
}

test('the ordinary order deletes the notice once the answer is out', async () => {
    const { transport, calls } = fakeTransport();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(transport);
    await notice.close('answered');
    assert.deepEqual(calls, ['delete']);
});

test('C-1: a close issued BEFORE the handle arrives still acts, and waits for it', async () => {
    const { transport, calls } = fakeTransport();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    // The post is still in flight, so there is nothing to close yet.
    const closing = notice.close('answered');
    assert.deepEqual(calls, [], 'nothing can have happened yet');
    notice.bind(transport);
    await closing;
    // Awaiting close() must mean the vendor work is DONE, not merely scheduled:
    // a registry drain tears the transport down the moment this resolves.
    assert.deepEqual(calls, ['delete']);
});

test('C-1: a late bind honours the recorded outcome instead of assuming answered', async () => {
    const { transport, calls } = fakeTransport();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const closing = notice.close('expired');
    notice.bind(transport);
    await closing;
    assert.deepEqual(calls, ['edit:' + EXPIRED], 'an expired turn must be rewritten, never deleted');
});

test('C-1: every close caller shares one completion and the first outcome wins', async () => {
    const { transport, calls } = fakeTransport();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(transport);
    const first = notice.close('answered');
    const second = notice.close('expired');
    await Promise.all([first, second]);
    assert.deepEqual(calls, ['delete'], 'one vendor call, and it is the first outcome');
});

test('B1-1: abandon then close resolves immediately', async () => {
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.abandon();
    // Must not hang waiting for a handle that will never arrive.
    await notice.close('expired');
});

test('B1-1: a close already in flight is resolved by abandon', async () => {
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const closing = notice.close('expired');
    notice.abandon();
    await closing;
});

test('B1-1: a bind after abandon is ignored and makes no vendor call', async () => {
    const { transport, calls } = fakeTransport();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.abandon();
    notice.bind(transport);
    await notice.close('answered');
    assert.deepEqual(calls, [], 'an abandoned notice must never revive');
});

test('C-2: a duplicate bind is ignored, and the FIRST transport is the one closed', async () => {
    const first = fakeTransport();
    const second = fakeTransport();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(first.transport);
    notice.bind(second.transport);
    await notice.close('answered');
    assert.deepEqual(first.calls, ['delete']);
    assert.deepEqual(second.calls, [], 'the second handle must never be touched');
});

test('a vendor failure is swallowed and still completes the close', async () => {
    const errors: unknown[] = [];
    const { transport } = fakeTransport({ async delete() { throw new Error('channel_not_found'); } });
    const notice = createQueueNotice({ expiredText: EXPIRED, onError: (e) => errors.push(e) });
    notice.bind(transport);
    await notice.close('answered');
    assert.equal(errors.length, 1, 'the failure is reported, not thrown at the reply path');
});

test('C-3: the deadline signal reaches the transport call', async () => {
    const { transport, seen } = fakeTransport();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(transport);
    const controller = new AbortController();
    await notice.close('answered', controller.signal);
    assert.equal(seen[0], controller.signal, 'a transport cannot honour a signal it never receives');
});

test('registry drain runs each teardown once and empties itself', async () => {
    const registry = new QueueNoticeRegistry();
    const ran: string[] = [];
    registry.add(async () => { ran.push('a'); });
    registry.add(async () => { ran.push('b'); });
    assert.equal(registry.size, 2);
    await registry.drain();
    assert.deepEqual(ran.sort(), ['a', 'b']);
    assert.equal(registry.size, 0);
});

test('an unregistered teardown is not run by a later drain', async () => {
    const registry = new QueueNoticeRegistry();
    const ran: string[] = [];
    const off = registry.add(async () => { ran.push('gone'); });
    registry.add(async () => { ran.push('kept'); });
    off();
    await registry.drain();
    assert.deepEqual(ran, ['kept']);
});

test('C-4: a teardown that throws SYNCHRONOUSLY cannot break the drain', async () => {
    const registry = new QueueNoticeRegistry();
    const ran: string[] = [];
    // Not an async throw: this one escapes before allSettled would ever see it.
    registry.add((() => { throw new Error('sync boom'); }) as unknown as () => Promise<void>);
    registry.add(async () => { ran.push('survivor'); });
    await registry.drain();
    assert.deepEqual(ran, ['survivor'], 'the other teardowns must still run');
    assert.equal(registry.size, 0);
});

test('C-3: drain returns at the deadline and aborts what is still running', async () => {
    const registry = new QueueNoticeRegistry();
    let observed: AbortSignal | undefined;
    // Never resolves: only the deadline can end this drain.
    registry.add((signal) => { observed = signal; return new Promise<void>(() => {}); });
    const started = Date.now();
    await registry.drain(50);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, 'drain must not wait on a hanging teardown, took ' + elapsed + 'ms');
    // Returning early only stops WAITING. The signal is what actually cancels, so
    // a drain that returns without aborting has merely hidden the hang.
    assert.equal(observed?.aborted, true, 'the deadline must abort the in-flight work');
});
