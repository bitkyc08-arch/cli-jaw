import test from 'node:test';
import assert from 'node:assert/strict';

import {
    startDraftStream,
    type DraftStreamOptions,
    type DraftTransport,
} from '../../src/messaging/draft-stream.ts';

type TimerRecord = {
    readonly id: number;
    readonly dueAt: number;
    readonly callback: () => void;
    cleared: boolean;
};

function deferred(): {
    readonly promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
} {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function fakeClock(startMs = 10_000): {
    readonly options: Pick<DraftStreamOptions, 'now' | 'setTimer' | 'clearTimer'>;
    readonly timers: TimerRecord[];
    now(): number;
    advance(ms: number): Promise<void>;
} {
    let nowMs = startMs;
    let nextId = 1;
    const timers: TimerRecord[] = [];

    const setTimer = ((callback: () => void, delay = 0) => {
        const record: TimerRecord = {
            id: nextId,
            dueAt: nowMs + delay,
            callback,
            cleared: false,
        };
        nextId += 1;
        timers.push(record);
        return {
            id: record.id,
            unref() { return this; },
        };
    }) as unknown as typeof setTimeout;

    const clearTimer = ((timer: { id?: number }) => {
        const record = timers.find(candidate => candidate.id === timer.id);
        if (record) record.cleared = true;
    }) as unknown as typeof clearTimeout;

    const runDue = async (): Promise<void> => {
        while (true) {
            const due = timers
                .filter(timer => !timer.cleared && timer.dueAt <= nowMs)
                .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
            if (!due) return;
            due.cleared = true;
            due.callback();
            await settle();
        }
    };

    return {
        options: { now: () => nowMs, setTimer, clearTimer },
        timers,
        now: () => nowMs,
        async advance(ms: number): Promise<void> {
            nowMs += ms;
            await runDue();
        },
    };
}

type TransportCall =
    | { readonly operation: 'post'; readonly text: string }
    | { readonly operation: 'edit'; readonly handle: string; readonly text: string }
    | { readonly operation: 'remove'; readonly handle: string };

function fakeTransport(overrides: Partial<DraftTransport> = {}): {
    readonly transport: DraftTransport;
    readonly calls: TransportCall[];
} {
    const calls: TransportCall[] = [];
    const transport: DraftTransport = {
        async post(text) {
            calls.push({ operation: 'post', text });
            return 'draft-1';
        },
        async edit(handle, text) {
            calls.push({ operation: 'edit', handle, text });
        },
        async remove(handle) {
            calls.push({ operation: 'remove', handle });
        },
        ...overrides,
    };
    return { transport, calls };
}

function editCalls(calls: TransportCall[]): Extract<TransportCall, { operation: 'edit' }>[] {
    return calls.filter((call): call is Extract<TransportCall, { operation: 'edit' }> => (
        call.operation === 'edit'
    ));
}

test('updates coalesce to the latest text and respect the edit interval', async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
    });

    stream.update('one');
    await clock.advance(0);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['one']);

    stream.update('two');
    stream.update('three');
    await clock.advance(1_199);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['one']);
    await clock.advance(1);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['one', 'three']);
});

test('an update after the interval is immediately eligible', async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
    });

    stream.update('one');
    await clock.advance(0);
    await clock.advance(1_300);
    stream.update('two');

    const scheduled = clock.timers.find(timer => !timer.cleared);
    assert.equal(scheduled?.dueAt, clock.now());
    await clock.advance(0);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['one', 'two']);
});

test('updates during an in-flight edit coalesce into one next-window edit', async () => {
    const clock = fakeClock();
    const firstEdit = deferred();
    let editCount = 0;
    const { transport, calls } = fakeTransport({
        async edit(handle, text) {
            calls.push({ operation: 'edit', handle, text });
            editCount += 1;
            if (editCount === 1) await firstEdit.promise;
        },
    });
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
    });

    stream.update('one');
    await clock.advance(0);
    stream.update('two');
    stream.update('three');
    firstEdit.resolve();
    await settle();

    await clock.advance(1_199);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['one']);
    await clock.advance(1);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['one', 'three']);
});

test('finalize bypasses the edit interval', async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
    });

    stream.update('progress');
    await clock.advance(0);
    assert.equal(await stream.finalize('answer'), true);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['progress', 'answer']);
    assert.equal(clock.now(), 10_000);
});

test('finalize waits for an in-flight edit before committing final text', async () => {
    const clock = fakeClock();
    const firstEdit = deferred();
    const { transport, calls } = fakeTransport({
        async edit(handle, text) {
            calls.push({ operation: 'edit', handle, text });
            if (text === 'progress') await firstEdit.promise;
        },
    });
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
    });

    stream.update('progress');
    await clock.advance(0);
    const finalized = stream.finalize('answer');
    await settle();
    assert.deepEqual(editCalls(calls).map(call => call.text), ['progress']);

    firstEdit.resolve();
    assert.equal(await finalized, true);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['progress', 'answer']);
});

test('unchanged updates and final text suppress transport edits', async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const stream = await startDraftStream(transport, 'same', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
    });

    stream.update('same');
    await clock.advance(0);
    assert.equal(await stream.finalize('same'), true);
    assert.deepEqual(editCalls(calls), []);
});

test('overflow removes the stale draft before returning fallback', async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 5,
        ...clock.options,
    });

    assert.equal(await stream.finalize('123456'), false);
    assert.deepEqual(calls.map(call => call.operation), ['post', 'remove']);
    assert.equal(stream.handle(), null);
    assert.deepEqual(editCalls(calls), []);
});

test('a failed final edit removes the draft and resolves false', async () => {
    const errors: string[] = [];
    const { transport, calls } = fakeTransport({
        async edit(handle, text) {
            calls.push({ operation: 'edit', handle, text });
            throw new Error('edit unavailable');
        },
    });
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        onError(operation) { errors.push(operation); },
    });

    assert.equal(await stream.finalize('answer'), false);
    assert.deepEqual(calls.map(call => call.operation), ['post', 'edit', 'remove']);
    assert.deepEqual(errors, ['edit']);
    assert.equal(stream.handle(), null);
});

test('discard cancels pending work and is idempotent', async () => {
    const clock = fakeClock();
    const { transport, calls } = fakeTransport();
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
    });

    stream.update('one');
    await clock.advance(0);
    stream.update('two');
    const pendingTimer = clock.timers.find(timer => !timer.cleared);
    assert.ok(pendingTimer);

    await stream.discard();
    await stream.discard();
    await clock.advance(1_200);
    assert.equal(pendingTimer.cleared, true);
    assert.deepEqual(calls.map(call => call.operation), ['post', 'edit', 'remove']);
    assert.equal(stream.handle(), null);
});

test('progress edit failures are swallowed and do not retry without new text', async () => {
    const clock = fakeClock();
    const errors: string[] = [];
    const { transport, calls } = fakeTransport({
        async edit(handle, text) {
            calls.push({ operation: 'edit', handle, text });
            throw new Error('edit unavailable');
        },
    });
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
        ...clock.options,
        onError(operation) { errors.push(operation); },
    });

    stream.update('progress');
    await clock.advance(0);
    await clock.advance(10_000);
    assert.deepEqual(editCalls(calls).map(call => call.text), ['progress']);
    assert.deepEqual(errors, ['edit']);
});

test('post, remove, and error-callback failures never reject public operations', async () => {
    const postFailure = await startDraftStream({
        async post() { throw new Error('post unavailable'); },
        async edit() { throw new Error('unreachable'); },
        async remove() { throw new Error('unreachable'); },
    }, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 5,
        onError() { throw new Error('diagnostics unavailable'); },
    });
    postFailure.update('ignored');
    assert.equal(await postFailure.finalize('answer'), false);
    await postFailure.discard();

    const { transport } = fakeTransport({
        async remove() { throw new Error('remove unavailable'); },
    });
    const removeFailure = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 5,
        onError() { throw new Error('diagnostics unavailable'); },
    });
    assert.equal(await removeFailure.finalize('answer'), false);
    assert.equal(removeFailure.handle(), null);
});

test('discard after successful finalize is a no-op', async () => {
    const { transport, calls } = fakeTransport();
    const stream = await startDraftStream(transport, 'initial', {
        minEditIntervalMs: 1_200,
        maxChars: 100,
    });

    assert.equal(await stream.finalize('answer'), true);
    await stream.discard();
    stream.update('late');
    assert.deepEqual(calls.map(call => call.operation), ['post', 'edit']);
    assert.equal(stream.handle(), 'draft-1');
});
