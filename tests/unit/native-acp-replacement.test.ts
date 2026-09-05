import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AcpReplacement, AcpReplacementError } from '../../src/agent/runtime/acp/replacement.ts';
import type { RuntimePrompt } from '../../src/agent/runtime/session.ts';

function deferred() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture() {
    const changed = new EventEmitter(), events: string[] = [];
    const starts: Array<{ prompt: RuntimePrompt; epoch: number; written: ReturnType<typeof deferred> }> = [];
    const cancels: Array<{ epoch: number; terminal: ReturnType<typeof deferred>; drained: ReturnType<typeof deferred> }> = [];
    const retired: Error[] = [];
    let onStart: ((epoch: number) => void) | undefined, retirementThrows = false;
    const control = new AcpReplacement({
        start(prompt, epoch) {
            const entry = { prompt, epoch, written: deferred() }; starts.push(entry);
            events.push('start:' + epoch); changed.emit('change'); onStart?.(epoch); return entry.written.promise;
        },
        cancelAndDrain() {
            const entry = { epoch: control.currentEpoch, terminal: deferred(), drained: deferred() }; cancels.push(entry);
            events.push('cancel:' + entry.epoch); changed.emit('change');
            return Promise.all([entry.terminal.promise, entry.drained.promise]).then(() => undefined);
        },
        retire(error) {
            retired.push(error); events.push('retire');
            for (const entry of starts) entry.written.reject(error);
            for (const entry of cancels) { entry.terminal.reject(error); entry.drained.reject(error); }
            if (retirementThrows) throw new Error('retirement hook failed');
        },
    });
    const waitFor = (predicate: () => boolean) => predicate() ? Promise.resolve() : new Promise<void>(resolve => {
        const check = () => { if (predicate()) { changed.off('change', check); resolve(); } }; changed.on('change', check);
    });
    const ready = async () => {
        const first = control.first({ text: 'A' }); await waitFor(() => starts.length === 1);
        starts[0]!.written.resolve(); await first;
    };
    const drain = (index = cancels.length - 1) => { cancels[index]!.terminal.resolve(); cancels[index]!.drained.resolve(); };
    return { control, starts, cancels, events, retired, waitFor, ready, drain,
        onStart: (callback: (epoch: number) => void) => { onStart = callback; },
        throwRetirement: () => { retirementThrows = true; } };
}

test('replacement waits original terminal and drain before advancing epoch or dispatching B', async () => {
    const f = fixture(); await f.ready();
    const replacement = f.control.replace({ text: 'B' });
    assert.equal(f.cancels.length, 1); assert.equal(f.control.hasPendingReplacement, true);
    assert.equal(f.control.currentEpoch, 1);
    f.cancels[0]!.terminal.resolve(); await nextTurn(); assert.equal(f.starts.length, 1);
    f.cancels[0]!.drained.resolve(); await f.waitFor(() => f.starts.length === 2);
    assert.equal(f.starts[1]!.epoch, 2); assert.equal(f.control.hasPendingReplacement, false);
    let accepted = false; const done = replacement.then(result => { accepted = true; return result; });
    await nextTurn(); assert.equal(accepted, false);
    f.starts[1]!.written.resolve(); assert.deepEqual(await done, { accepted: true, epoch: 2 });
    assert.deepEqual(f.events, ['start:1', 'cancel:1', 'start:2']);
});

test('cancellation starts while the initial write is held, not behind the admission lock', async () => {
    const f = fixture(), first = f.control.first({ text: 'A' });
    await f.waitFor(() => f.starts.length === 1);
    const replacement = f.control.replace({ text: 'B' });
    assert.equal(f.cancels.length, 1, 'the cancellation budget must already be running');
    f.drain(); await nextTurn(); assert.equal(f.starts.length, 1);
    f.starts[0]!.written.resolve(); await first; await f.waitFor(() => f.starts.length === 2);
    f.starts[1]!.written.resolve(); assert.equal((await replacement).accepted, true);
});

test('latest intent supersedes only before start and coalesces the old cancellation', async () => {
    const f = fixture(); await f.ready();
    const b = f.control.replace({ text: 'B' }), c = f.control.replace({ text: 'C' });
    assert.equal(f.cancels.length, 1); f.drain();
    assert.deepEqual(await b, { accepted: false, epoch: 1, reason: 'superseded' });
    await f.waitFor(() => f.starts.length === 2); assert.equal(f.starts[1]!.prompt.text, 'C');
    f.starts[1]!.written.resolve(); assert.deepEqual(await c, { accepted: true, epoch: 2 });
});

test('a later intent cannot retract a request that has entered dispatch', async () => {
    const f = fixture(); await f.ready();
    const b = f.control.replace({ text: 'B' }); f.drain(); await f.waitFor(() => f.starts.length === 2);
    const c = f.control.replace({ text: 'C' });
    assert.equal(f.cancels.length, 2); assert.equal(f.cancels[1]!.epoch, 2);
    f.starts[1]!.written.resolve(); assert.deepEqual(await b, { accepted: true, epoch: 2 });
    f.drain(); await f.waitFor(() => f.starts.length === 3); f.starts[2]!.written.resolve();
    assert.deepEqual(await c, { accepted: true, epoch: 3 });
});

test('stop latches immediately, cancels once and suppresses pending replacements', async () => {
    const f = fixture(); await f.ready();
    const replacement = f.control.replace({ text: 'B' }); const stop = f.control.stop();
    assert.equal(f.control.isStopped, true); assert.equal(f.control.stop(), stop); assert.equal(f.cancels.length, 1);
    f.drain(); await stop;
    assert.deepEqual(await replacement, { accepted: false, epoch: 1, reason: 'stopped' });
    assert.equal(f.starts.length, 1);
    assert.deepEqual(await f.control.replace({ text: 'C' }), { accepted: false, epoch: 1, reason: 'stopped' });
    assert.equal(f.retired.length, 0);
});

test('stop before the first queued start performs no IO', async () => {
    const f = fixture();
    const first = f.control.first({ text: 'A' }); const rejected = assert.rejects(first, /acp_control_stopped/);
    await f.control.stop(); await rejected;
    assert.equal(f.starts.length, 0); assert.equal(f.cancels.length, 0); assert.equal(f.retired.length, 0);
});

test('stop is reentrant during synchronous registration and still waits the dispatch/drain', async () => {
    const f = fixture(); let stop: Promise<void> | undefined;
    f.onStart(() => { stop = f.control.stop(); });
    const first = f.control.first({ text: 'A' }); await f.waitFor(() => f.starts.length === 1);
    assert.equal(f.control.isStopped, true); assert.equal(f.cancels.length, 1);
    f.starts[0]!.written.resolve(); f.drain(); await first; await stop;
});

test('replacement is reentrant during a replacement registration without duplicating starts', async () => {
    const f = fixture(); await f.ready(); let c: ReturnType<AcpReplacement['replace']> | undefined;
    f.onStart(epoch => { if (epoch === 2) c = f.control.replace({ text: 'C' }); });
    const b = f.control.replace({ text: 'B' }); f.drain(); await f.waitFor(() => f.starts.length === 2);
    assert.equal(f.cancels.length, 2); f.starts[1]!.written.resolve(); assert.equal((await b).accepted, true);
    f.drain(); await f.waitFor(() => f.starts.length === 3); f.starts[2]!.written.resolve();
    assert.deepEqual(await c, { accepted: true, epoch: 3 });
});

test('prompt values are captured before waiting; no actual image capability is claimed by this IO fixture', async () => {
    const f = fixture(); await f.ready();
    const prompt = { text: 'B', images: [{ mimeType: 'fixture/type', data: 'before' }] };
    const replacement = f.control.replace(prompt); prompt.text = 'changed'; prompt.images[0]!.data = 'changed';
    f.drain(); await f.waitFor(() => f.starts.length === 2);
    assert.deepEqual(f.starts[1]!.prompt, { text: 'B', images: [{ mimeType: 'fixture/type', data: 'before' }] });
    f.starts[1]!.written.resolve(); await replacement;
});

test('pending transition capacity rejects before cancelling or superseding an admitted intent', async () => {
    const f = fixture(); await f.ready();
    const pending = Array.from({ length: 32 }, (_, i) => f.control.replace({ text: String(i) }));
    assert.deepEqual(await f.control.replace({ text: 'overflow' }), { accepted: false, epoch: 1, reason: 'capacity' });
    assert.equal(f.cancels.length, 1); f.drain(); await f.waitFor(() => f.starts.length === 2);
    assert.equal(f.starts[1]!.prompt.text, '31'); f.starts[1]!.written.resolve();
    const results = await Promise.all(pending); assert.equal(results.filter(result => result.accepted).length, 1);
});

test('cancel failure while dispatch is held rejects both operations with one fatal retirement', async () => {
    const f = fixture(), cause = new Error('cancel timeout');
    const first = f.control.first({ text: 'A' }); await f.waitFor(() => f.starts.length === 1);
    const replacement = f.control.replace({ text: 'B' });
    const a = assert.rejects(first, AcpReplacementError), b = assert.rejects(replacement, AcpReplacementError);
    f.cancels[0]!.terminal.reject(cause); await Promise.all([a, b]);
    assert.equal(f.retired.length, 1); assert.equal((f.retired[0] as AcpReplacementError).stage, 'cancel');
    assert.equal(f.retired[0]!.cause, cause); assert.equal(f.control.isStopped, true);
    await assert.rejects(f.control.replace({ text: 'C' }), AcpReplacementError); assert.equal(f.starts.length, 1);
});

test('replacement dispatch failure retires and rejects rather than returning a retryable no-start', async () => {
    const f = fixture(); await f.ready();
    const replacement = f.control.replace({ text: 'B' }); const rejected = assert.rejects(replacement, AcpReplacementError);
    f.drain(); await f.waitFor(() => f.starts.length === 2); f.starts[1]!.written.reject(new Error('write failed'));
    await rejected; assert.equal(f.retired.length, 1); assert.equal((f.retired[0] as AcpReplacementError).stage, 'dispatch');
    await assert.rejects(f.control.replace({ text: 'C' }), AcpReplacementError); assert.equal(f.starts.length, 2);
});

test('first failure keeps the fatal type even if retirement itself throws', async () => {
    const f = fixture(); f.throwRetirement();
    const first = f.control.first({ text: 'A' }); const rejected = assert.rejects(first, AcpReplacementError);
    await f.waitFor(() => f.starts.length === 1); f.starts[0]!.written.reject(new Error('write failed'));
    await rejected; assert.equal(f.retired.length, 1); assert.equal(f.control.isStopped, true);
});

test('before-first replacement and duplicate first do not disturb the original attempt', async () => {
    const f = fixture(); assert.deepEqual(await f.control.replace({ text: 'B' }), { accepted: false, epoch: 0, reason: 'not-started' });
    const first = f.control.first({ text: 'A' });
    await assert.rejects(f.control.first({ text: 'duplicate' }), /acp_control_already_started/);
    await f.waitFor(() => f.starts.length === 1); f.starts[0]!.written.resolve(); await first;
    assert.equal(f.retired.length, 0);
});
