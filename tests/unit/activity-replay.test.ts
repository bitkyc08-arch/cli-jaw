import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityReplay } from '../../src/shared/activity-replay.js';
import { applyActivityEvent, createActivityState, type ActivityState } from '../../src/shared/activity-state.js';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.js';

const identity = { version: 1 as const, runId: 'r', sessionId: 's', scope: 'local:s', turnId: 't' };
const key = '["s","local:s","r","t"]';
const event = (seq: number, body: RuntimeEventBody, runId = 'r'): RuntimeEvent => ({ ...identity, runId, seq, ...body });
const delta = (seq: number, text: string, runId = 'r'): RuntimeEvent =>
    event(seq, { kind: 'message', itemId: 'm', phase: 'commentary', operation: 'append', text }, runId);
const end = (seq: number, runId = 'r'): RuntimeEvent => event(seq, { kind: 'turn-end', status: 'done', finalText: '' }, runId);
const text = (state: ActivityState): string | undefined => {
    const entry = state.entries.get('m');
    return entry?.kind === 'message' ? entry.text : undefined;
};
function deferred() {
    let resolve!: (events: readonly RuntimeEvent[]) => void;
    let reject!: (error: Error) => void;
    let signal!: AbortSignal;
    const promise = new Promise<readonly RuntimeEvent[]>((yes, no) => { resolve = yes; reject = no; });
    return { resolve, reject, get signal() { return signal; }, read: (value: AbortSignal) => { signal = value; return promise; } };
}

test('buffers live, folds snapshot atomically, deduplicates overlap and keeps terminal finality', async () => {
    const seen: Array<{ text: string | undefined; ended: boolean }> = [];
    const replay = new ActivityReplay(state => seen.push({ text: text(state), ended: !!state.end }));
    const read = deferred();
    const work = replay.restore(read.read);
    assert.equal(replay.live(delta(3, 'b')), true);
    assert.equal(replay.live(delta(3, 'b')), false);
    assert.equal(replay.live(end(9)), true);
    assert.equal(replay.live(delta(10, 'after final')), false);
    assert.equal(replay.turns.size, 0);
    assert.deepEqual(seen, []);
    read.resolve([delta(1, 'a'), delta(3, 'b')]);
    await work;
    assert.deepEqual(seen, [{ text: 'ab', ended: true }]);
    assert.equal(replay.turns.get(key)?.end?.finalText, '');
    assert.equal(replay.live(end(9)), false);
    assert.equal(replay.live(delta(12, 'late')), false);
});

test('fixed tuple keys isolate every identity field and identical item ids', async () => {
    const replay = new ActivityReplay(() => {});
    const variants = [delta(1, 'base'), { ...delta(1, 'session'), sessionId: 'other' },
        { ...delta(1, 'scope'), scope: 'other' }, delta(1, 'run', 'other'), { ...delta(1, 'turn'), turnId: 'other' }];
    await replay.restore(async () => variants);
    assert.deepEqual([...replay.turns.keys()], [key, '["other","local:s","r","t"]',
        '["s","other","r","t"]', '["s","local:s","other","t"]', '["s","local:s","r","other"]']);
    assert.deepEqual([...replay.turns.values()].map(text), ['base', 'session', 'scope', 'run', 'turn']);
});

test('sparse seq is valid and snapshot repairs lost live text without duplicating append', async () => {
    const replay = new ActivityReplay(() => {});
    replay.live(delta(10, 'a'));
    replay.live(delta(50, 'c'));
    const state = replay.turns.get(key)!;
    assert.equal(text(state), 'ac');
    await replay.restore(async () => [delta(10, 'a'), delta(30, 'b'), delta(50, 'c')]);
    assert.equal(replay.turns.get(key), state);
    assert.equal(text(state), 'abc');
    assert.equal(state.seq, 50);
    assert.equal(state.omitted.entries, 0);
    assert.equal(replay.live(delta(50, 'c')), false);
});

test('older per-run snapshot retains known live model and publishes no stale callback', async () => {
    let calls = 0;
    const replay = new ActivityReplay(() => { calls++; });
    replay.live(delta(100, 'known live'));
    const state = replay.turns.get(key)!;
    const before = structuredClone(state);
    const read = deferred();
    const work = replay.restore(read.read);
    assert.equal(replay.live(delta(99, 'stale')), false);
    read.resolve([delta(1, 'older seed'), delta(2, 'other run', 'other')]);
    await work;
    assert.equal(replay.turns.get(key), state);
    assert.deepEqual(state, before);
    assert.equal(calls, 2); // Initial live + only the other run.
});

test('preseeded browser model uses one canonical reducer and retains its reference', async () => {
    const state = createActivityState(identity);
    applyActivityEvent(state, delta(1, 'a'));
    const seen: ActivityState[] = [];
    const replay = new ActivityReplay(value => seen.push(value));
    replay.turns.set(key, state);
    assert.equal(replay.live(delta(1, 'a')), false);
    assert.equal(replay.live(delta(2, 'b')), true);
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(3, 'c'));
    read.resolve([delta(1, 'a'), delta(2, 'b')]);
    await work;
    assert.equal(replay.turns.get(key), state);
    assert.equal(text(state), 'abc');
    assert.ok(seen.every(value => value === state));
});

test('reset aborts uncooperative reads immediately and ignores late data and pending', async () => {
    let calls = 0;
    const replay = new ActivityReplay(() => { calls++; });
    replay.live(delta(1, 'old'));
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(2, 'pending'));
    replay.reset();
    assert.equal(read.signal.aborted, true);
    await work;
    replay.live(delta(1, 'new'));
    read.resolve([delta(3, 'late')]);
    await Promise.resolve();
    assert.equal(text(replay.turns.get(key)!), 'new');
    assert.equal(calls, 2);
});

test('superseding restore transfers pending once and old rejection has no callbacks', async () => {
    const seen: Array<string | undefined> = [];
    const replay = new ActivityReplay(state => seen.push(text(state)));
    const first = deferred();
    const oldWork = replay.restore(first.read);
    replay.live(delta(2, 'b'));
    const second = deferred();
    const work = replay.restore(second.read);
    assert.equal(first.signal.aborted, true);
    await oldWork;
    first.reject(new Error('late old failure'));
    assert.deepEqual(seen, []);
    assert.equal(replay.live(delta(2, 'duplicate')), false);
    replay.live(delta(3, 'c'));
    second.resolve([delta(1, 'a'), delta(2, 'b')]);
    await work;
    assert.equal(text(replay.turns.get(key)!), 'abc');
    assert.deepEqual(seen, ['abc']);
});

test('late superseded snapshot cannot overwrite or flush the current read', async () => {
    const seen: Array<string | undefined> = [];
    const replay = new ActivityReplay(state => seen.push(text(state)));
    const first = deferred();
    const oldWork = replay.restore(first.read);
    const second = deferred();
    const work = replay.restore(second.read);
    replay.live(delta(5, 'live'));
    first.resolve([delta(100, 'obsolete')]);
    await oldWork;
    assert.equal(replay.turns.size, 0);
    assert.deepEqual(seen, []);
    second.resolve([delta(1, 'fresh')]);
    await work;
    assert.deepEqual(seen, ['freshlive']);
});

test('read failure preserves models, drains admitted live and propagates original failure', async () => {
    const replay = new ActivityReplay(() => {});
    replay.live(delta(1, 'a'));
    const state = replay.turns.get(key)!;
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(2, 'b'));
    replay.live(end(8));
    const failure = new Error('read failed');
    read.reject(failure);
    await assert.rejects(work, error => error === failure);
    assert.equal(replay.turns.get(key), state);
    assert.equal(text(state), 'ab');
    assert.equal(state.end?.status, 'done');
    assert.equal(read.signal.aborted, true);
});

test('synchronous reader failure is propagated and leaves replay usable', async () => {
    const replay = new ActivityReplay(() => {});
    const failure = new Error('sync read failure');
    await assert.rejects(replay.restore(() => { throw failure; }), error => error === failure);
    assert.equal(replay.live(delta(1, 'usable')), true);
});

test('event-count overflow aborts and rejects immediately, drains exactly 256 admitted events', async () => {
    const replay = new ActivityReplay(() => {});
    replay.live(delta(1, 'a'));
    const state = replay.turns.get(key)!;
    const read = deferred();
    const work = replay.restore(read.read);
    for (let seq = 2; seq <= 257; seq++) assert.equal(replay.live(delta(seq, 'b')), true);
    assert.equal(replay.live(delta(257, 'duplicate at limit')), false);
    assert.throws(() => replay.live(delta(258, 'not admitted')), /activity_live_buffer_overflow/);
    assert.equal(read.signal.aborted, true);
    await assert.rejects(work, /activity_live_buffer_overflow/);
    assert.equal(replay.turns.get(key), state);
    assert.equal(text(state), 'a' + 'b'.repeat(256));
    assert.equal(state.seq, 257);
    read.resolve([delta(999, 'late overwrite')]);
    await Promise.resolve();
    assert.equal(state.seq, 257);
    await replay.restore(async () => []);
    assert.equal(replay.live(delta(258, 'c')), true);
});

test('byte overflow counts UTF-8 bytes, preserves state and excludes the rejected event', async () => {
    const replay = new ActivityReplay(() => {});
    replay.live(delta(1, 'a'));
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(2, 'b'));
    // Below 1MiB in JS string length; above it on the wire.
    assert.throws(() => replay.live(delta(3, '한'.repeat(350_000))), /activity_live_buffer_overflow/);
    await assert.rejects(work, /activity_live_buffer_overflow/);
    assert.equal(read.signal.aborted, true);
    assert.equal(text(replay.turns.get(key)!), 'ab');
    assert.equal(replay.turns.get(key)?.seq, 2);
});

test('1MiB pending byte budget is inclusive and aggregate across events', async () => {
    const replay = new ActivityReplay(() => {});
    const read = deferred();
    const work = replay.restore(read.read);
    const first = delta(1, 'a'.repeat(500_000));
    const encoder = new TextEncoder();
    const remaining = 1024 * 1024 - encoder.encode(JSON.stringify(first)).length;
    const secondOverhead = encoder.encode(JSON.stringify(delta(2, ''))).length;
    assert.equal(replay.live(first), true);
    assert.equal(replay.live(delta(2, 'b'.repeat(remaining - secondOverhead))), true);
    assert.throws(() => replay.live(delta(3, '')), /activity_live_buffer_overflow/);
    await assert.rejects(work, /activity_live_buffer_overflow/);
    assert.equal(replay.turns.get(key)?.seq, 2);
});

test('a newer snapshot cannot reopen an already closed live turn', async () => {
    let calls = 0;
    const replay = new ActivityReplay(() => { calls++; });
    replay.live(delta(1, 'a'));
    replay.live(end(2));
    const before = structuredClone(replay.turns.get(key));
    await replay.restore(async () => [delta(1, 'different'), delta(3, 'late')]);
    assert.deepEqual(replay.turns.get(key), before);
    assert.equal(calls, 2);
});

test('invalid item kind aborts snapshot atomically across runs and drains valid pending', async () => {
    const seen: Array<string | undefined> = [];
    const replay = new ActivityReplay(state => seen.push(text(state)));
    replay.live(delta(1, 'existing'));
    const state = replay.turns.get(key)!;
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(2, '+live'));
    read.resolve([delta(1, 'replacement'), delta(2, 'new run', 'other'),
        event(3, { kind: 'tool', itemId: 'm', name: 'conflict', status: 'running' }, 'other')]);
    await assert.rejects(work, /runtime_item_kind_changed/);
    assert.equal(read.signal.aborted, true);
    assert.equal(replay.turns.size, 1);
    assert.equal(replay.turns.get(key), state);
    assert.deepEqual(seen, ['existing', 'existing+live']);
});

test('pending kind failure is reported while later valid pending still drains', async () => {
    const replay = new ActivityReplay(() => {});
    replay.live(delta(1, 'a'));
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(event(2, { kind: 'tool', itemId: 'm', name: 'invalid', status: 'running' }));
    replay.live(delta(3, 'b'));
    read.resolve([]);
    await assert.rejects(work, error => error instanceof AggregateError
        && error.errors.every(cause => cause.message === 'runtime_item_kind_changed'));
    assert.equal(text(replay.turns.get(key)!), 'ab');
});

test('pending conflict with a new seed leaves existing models intact and drains against them', async () => {
    const seen: Array<string | undefined> = [];
    const replay = new ActivityReplay(state => seen.push(text(state)));
    replay.live(delta(1, 'known'));
    const state = replay.turns.get(key)!;
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(3, '+live'));
    read.resolve([event(2, { kind: 'tool', itemId: 'm', name: 'wrong seed kind', status: 'running' })]);
    await assert.rejects(work, /runtime_item_kind_changed/);
    assert.equal(read.signal.aborted, true);
    assert.equal(replay.turns.get(key), state);
    assert.deepEqual(seen, ['known', 'known+live']);
});

test('16 running turns reject new live or snapshot capacity without eviction or partial adoption', async () => {
    const replay = new ActivityReplay(() => {});
    for (let i = 0; i < 16; i++) replay.live(delta(1, 'running', `r${i}`));
    const before = new Map(replay.turns);
    assert.throws(() => replay.live(delta(1, 'overflow', 'extra')), /activity_turn_capacity/);
    await assert.rejects(replay.restore(async () => [delta(1, 'would replace', 'r0'),
        delta(2, 'newer', 'r0'), delta(1, 'overflow', 'extra')]), /activity_turn_capacity/);
    assert.deepEqual(replay.turns, before);
    assert.ok([...replay.turns.values()].every(state => text(state) === 'running'));
    const empty = new ActivityReplay(() => {});
    await assert.rejects(empty.restore(async () => Array.from({ length: 17 }, (_, i) =>
        delta(1, 'running', `r${i}`))), /activity_turn_capacity/);
    assert.equal(empty.turns.size, 0);
});

test('only closed turns are evicted, including turns closed by the atomic seed', async () => {
    const replay = new ActivityReplay(() => {});
    for (let i = 0; i < 16; i++) replay.live(delta(1, 'a', `r${i}`));
    const running = replay.turns.get('["s","local:s","r0","t"]');
    await replay.restore(async () => [delta(1, 'new', 'new'), delta(1, 'a', 'r7'), end(2, 'r7')]);
    assert.equal(replay.turns.size, 16);
    assert.equal(replay.turns.has('["s","local:s","r7","t"]'), false);
    assert.equal(replay.turns.get('["s","local:s","r0","t"]'), running);
    replay.live(end(3, 'r8'));
    replay.live(delta(1, 'next', 'next'));
    assert.equal(replay.turns.size, 16);
    assert.equal(replay.turns.has('["s","local:s","r8","t"]'), false);
});

test('all snapshot states are adopted before callbacks and callback reset suppresses later publication', async () => {
    const seen: number[] = [];
    const replay = new ActivityReplay(() => { seen.push(replay.turns.size); replay.reset(); });
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(3, 'discarded'));
    read.resolve([delta(1, 'a'), delta(1, 'b', 'other')]);
    await work;
    assert.deepEqual(seen, [2]);
    assert.equal(replay.turns.size, 0);
});

test('restore started by a failed-read drain callback inherits remaining admitted live', async () => {
    const second = deferred();
    let next: Promise<void> | undefined;
    const replay = new ActivityReplay(state => {
        if (state.seq === 2 && !next) next = replay.restore(second.read);
    });
    replay.live(delta(1, 'a'));
    const first = deferred();
    const work = replay.restore(first.read);
    replay.live(delta(2, 'b'));
    replay.live(delta(3, 'c'));
    first.reject(new Error('read failed'));
    await assert.rejects(work, /read failed/);
    assert.ok(next);
    second.resolve([delta(1, 'a'), delta(2, 'b')]);
    await next;
    assert.equal(text(replay.turns.get(key)!), 'abc');
});

test('failed-read drain serializes reentrant live after all admitted pending events', async () => {
    const seen: Array<string | undefined> = [];
    const admitted: boolean[] = [];
    const replay = new ActivityReplay(state => {
        seen.push(text(state));
        if (state.seq === 2) admitted.push(replay.live(delta(4, 'd')));
    });
    replay.live(delta(1, 'a'));
    const read = deferred();
    const work = replay.restore(read.read);
    replay.live(delta(2, 'b'));
    replay.live(delta(3, 'c'));
    const failure = new Error('read failed');
    read.reject(failure);
    await assert.rejects(work, error => error === failure);
    assert.equal(text(replay.turns.get(key)!), 'abcd');
    assert.deepEqual(seen, ['a', 'ab', 'abc', 'abcd']);
    assert.deepEqual(admitted, [true]);
});

test('previous abort listener reset settles the new restore without starting its uncooperative read', async () => {
    let calls = 0;
    let reads = 0;
    const replay = new ActivityReplay(() => { calls++; });
    const first = deferred();
    const oldWork = replay.restore(first.read);
    first.signal.addEventListener('abort', () => replay.reset(), { once: true });
    const second = deferred();
    const work = replay.restore(signal => { reads++; return second.read(signal); });
    try {
        // Cancellation must settle in microtasks, without needing the reader to finish.
        const result = await Promise.race([work.then(() => 'settled'),
            new Promise<string>(resolve => setImmediate(() => resolve('pending')))]);
        assert.equal(result, 'settled');
        assert.equal(reads, 0);
        assert.equal(calls, 0);
        assert.equal(replay.turns.size, 0);
    } finally {
        second.resolve([delta(1, 'late')]);
        await Promise.all([oldWork, work]);
    }
});

test('16 incomplete historical states marked settled admit live without fabricated ends or callbacks', async () => {
    let calls = 0;
    const replay = new ActivityReplay(() => { calls++; });
    await replay.restore(async () => Array.from({ length: 16 }, (_, i) => delta(1, 'partial', `r${i}`)));
    const states = [...replay.turns.values()];
    const before = structuredClone(states);
    for (let i = 0; i < 16; i++) replay.markSettled(`r${i}`);
    assert.deepEqual(states, before);
    assert.ok(states.every(state => state.end === null));
    assert.equal(calls, 16);
    for (let i = 0; i < 16; i++) assert.equal(replay.live(delta(1, 'live', `new${i}`)), true);
    assert.equal(replay.turns.size, 16);
    assert.throws(() => replay.live(delta(1, 'overflow', 'extra')), /activity_turn_capacity/);
});

test('settlement marks only existing exact run keys and never future or neighboring runs', () => {
    const replay = new ActivityReplay(() => {});
    for (let i = 0; i < 1000; i++) replay.markSettled(`future${i}`);
    replay.live(delta(1, 'partial', 'r'));
    replay.live({ ...delta(1, 'partial', 'r'), turnId: 'second' });
    replay.markSettled('r');
    for (let i = 0; i < 14; i++) replay.live(delta(1, 'running', `future${i}`));
    replay.live(delta(1, 'new', 'new0'));
    replay.live(delta(1, 'new', 'new1'));
    assert.ok([...replay.turns.values()].every(state => state.identity.runId !== 'r'));
    assert.throws(() => replay.live(delta(1, 'overflow', 'extra')), /activity_turn_capacity/);
});

test('settlement markers are removed on live eviction and reset before identity reuse', () => {
    const replay = new ActivityReplay(() => {});
    for (let i = 0; i < 16; i++) replay.live(delta(1, 'partial', `r${i}`));
    replay.markSettled('r0');
    replay.live(delta(1, 'new', 'new'));
    replay.markSettled('r1');
    replay.live(delta(1, 'reused', 'r0'));
    assert.throws(() => replay.live(delta(1, 'overflow', 'extra')), /activity_turn_capacity/);
    replay.markSettled('r0');
    replay.reset();
    for (let i = 0; i < 16; i++) replay.live(delta(1, 'running', `r${i}`));
    assert.throws(() => replay.live(delta(1, 'overflow', 'extra')), /activity_turn_capacity/);
});

test('failed transactional eviction preserves settlement markers and successful publish prunes them', async () => {
    const replay = new ActivityReplay(() => {});
    for (let i = 0; i < 16; i++) replay.live(delta(1, 'partial', `r${i}`));
    replay.markSettled('r0');
    const before = structuredClone(replay.turns);
    await assert.rejects(replay.restore(async () => [delta(1, 'new', 'new0'), delta(1, 'new', 'new1')]),
        /activity_turn_capacity/);
    assert.deepEqual(replay.turns, before);
    await replay.restore(async () => [delta(1, 'new', 'new0')]);
    assert.equal(replay.turns.size, 16);
    assert.ok([...replay.turns.values()].every(state => state.identity.runId !== 'r0'));
    replay.markSettled('r1');
    replay.live(delta(1, 'reused', 'r0'));
    assert.throws(() => replay.live(delta(1, 'overflow', 'extra')), /activity_turn_capacity/);
});

test('settled incomplete seeds still accept canonical final events and pending live can evict them', async () => {
    const replay = new ActivityReplay(() => {});
    replay.live(delta(1, 'partial', 'final'));
    replay.markSettled('final');
    assert.equal(replay.live(end(2, 'final')), true);
    assert.equal([...replay.turns.values()][0]?.end?.status, 'done');
    replay.reset();
    for (let i = 0; i < 16; i++) replay.live(delta(1, 'partial', `r${i}`));
    const read = deferred();
    const work = replay.restore(read.read);
    replay.markSettled('r0');
    replay.live(delta(1, 'new', 'new'));
    read.resolve([]);
    await work;
    assert.equal(replay.turns.size, 16);
    assert.ok([...replay.turns.values()].every(state => state.identity.runId !== 'r0' && state.end === null));
});
