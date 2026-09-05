import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpNotificationQueue } from '../../src/agent/runtime/acp/notification-queue.ts';
import type { RpcFrame } from '../../src/agent/runtime/acp/wire.ts';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}
const frame = (text = 'value'): RpcFrame => ({ jsonrpc: '2.0', method: 'session/update', params: { text } });

test('notification work is serial and terminal sealing still drains previously admitted work', async () => {
    const started = deferred(), held = deferred(), order: string[] = [];
    const queue = new AcpNotificationQueue(() => assert.fail('unexpected queue failure'));
    queue.enqueue(frame(), async () => { order.push('first'); started.resolve(); await held.promise; order.push('first-done'); });
    queue.enqueue(frame(), () => { order.push('second'); });
    await started.promise;
    assert.deepEqual(order, ['first']);
    queue.seal();
    assert.throws(() => queue.enqueue(frame(), () => {}), /acp_notification_after_terminal/);
    held.resolve();
    await queue.drain();
    assert.deepEqual(order, ['first', 'first-done', 'second']);
    assert.equal(queue.idle, true);
});
test('256 queued notifications fit and the next fails closed before retaining more', async () => {
    const failures: string[] = [], consumed: number[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    for (let i = 0; i < 256; i++) queue.enqueue(frame(), () => { consumed.push(i); });
    assert.equal(failures.length, 0);
    queue.enqueue(frame(), () => { consumed.push(256); });
    await assert.rejects(queue.drain(), /acp_notification_limit/);
    assert.deepEqual(failures, ['acp_notification_limit']);
    assert.deepEqual(consumed, []);
    assert.equal(queue.idle, true);
});
test('notification byte admission includes active and queued envelopes', async () => {
    const held = deferred(), started = deferred();
    const failures: string[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    const base = frame('');
    const part = frame('x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(base))));
    queue.enqueue(part, async (_frame, signal) => {
        started.resolve(); signal.addEventListener('abort', held.resolve, { once: true }); await held.promise;
    });
    await started.promise;
    queue.enqueue(part, () => {});
    assert.equal(failures.length, 0);
    queue.enqueue(frame(), () => {});
    await assert.rejects(queue.drain(), /acp_notification_limit/);
    assert.deepEqual(failures, ['acp_notification_limit']);
});
test('close aborts a stalled consumer and queued work cannot apply later', async () => {
    const started = deferred(), held = deferred();
    let applied = 0, signal: AbortSignal | undefined;
    const queue = new AcpNotificationQueue(() => assert.fail('intentional close is not another failure'));
    queue.enqueue(frame(), async (_frame, current) => {
        signal = current; started.resolve(); await held.promise;
        if (!current.aborted) applied++;
    });
    queue.enqueue(frame(), () => { applied++; });
    await started.promise;
    const drain = queue.drain();
    queue.close();
    assert.equal(signal?.aborted, true);
    await assert.rejects(drain, /acp_notification_closed/);
    held.resolve();
    await Promise.resolve();
    assert.equal(applied, 0);
    assert.equal(queue.idle, true);
});
test('consumer failure is fixed-code, settles drain and reports once', async () => {
    const failures: string[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    queue.enqueue(frame(), () => { throw new Error('private consumer text'); });
    await assert.rejects(queue.drain(), /acp_notification_consumer_failed/);
    queue.close();
    assert.deepEqual(failures, ['acp_notification_consumer_failed']);
});
test('invalid or reentrantly closed serialization cannot be retained', async () => {
    const failures: string[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    const invalid = { ...frame(), toJSON: () => undefined };
    queue.enqueue(invalid, () => assert.fail('invalid notification consumed'));
    await assert.rejects(queue.drain(), /acp_invalid_notification/);
    const other = new AcpNotificationQueue(() => {});
    const closing = { ...frame(), toJSON() { other.close(); return frame(); } };
    assert.throws(() => other.enqueue(closing, () => assert.fail('closed notification consumed')), /acp_notification_after_terminal/);
    assert.equal(other.idle, true);
});
