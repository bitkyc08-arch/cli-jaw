import test from 'node:test';
import assert from 'node:assert/strict';
import {
    publish, subscribe, replaySince, hasReplayGap, currentSeq,
    RING_SIZE, type BusEvent,
} from '../src/core/event-bus.ts';
import { broadcast } from '../src/core/bus.ts';

// Module-level ring/seq persist across tests — every test reads currentSeq()
// first and asserts relatively, so order or prior publishes never matter.

test('publish delivers synchronously to subscribers', () => {
    const got: BusEvent[] = [];
    const unsub = subscribe(e => { got.push(e); });
    publish('system', 'system_notice', { msg: 'hello' });
    unsub();
    assert.equal(got.length, 1);
    assert.equal(got[0]!.topic, 'system');
    assert.equal(got[0]!.event, 'system_notice');
    assert.equal(got[0]!.data['msg'], 'hello');
});

test('seq increments monotonically', () => {
    const before = currentSeq();
    publish('queue', 'queue_update', {});
    publish('queue', 'queue_update', {});
    assert.equal(currentSeq(), before + 2);
});

test('replaySince returns exactly the events after lastId', () => {
    const mark = currentSeq();
    publish('goal', 'goal_done', { n: 1 });
    publish('goal', 'goal_done', { n: 2 });
    publish('goal', 'goal_done', { n: 3 });
    const replayed = replaySince(mark + 1);
    assert.equal(replayed.length, 2);
    assert.equal(replayed[0]!.data['n'], 2);
    assert.equal(replayed[1]!.data['n'], 3);
});

test('ring buffer caps at RING_SIZE and evicts oldest', () => {
    for (let i = 0; i < RING_SIZE + 10; i++) {
        publish('agent', 'agent_status', { i });
    }
    const all = replaySince(0);
    assert.equal(all.length, RING_SIZE);
    // Oldest surviving id is current seq - RING_SIZE + 1
    assert.equal(all[0]!.id, currentSeq() - RING_SIZE + 1);
});

test('hasReplayGap detects evicted lastId and accepts fresh lastId', () => {
    // After the overflow test above, id=1 is long evicted.
    assert.equal(hasReplayGap(1), true);
    assert.equal(hasReplayGap(currentSeq()), false);
    assert.equal(hasReplayGap(0), false); // 0 = no prior connection, never a gap
});

test('unsubscribe stops delivery', () => {
    const got: BusEvent[] = [];
    const unsub = subscribe(e => { got.push(e); });
    publish('memory', 'memory_status', {});
    unsub();
    publish('memory', 'memory_status', {});
    assert.equal(got.length, 1);
});

test('a throwing listener does not break publish or other listeners', () => {
    const got: BusEvent[] = [];
    const unsubBad = subscribe(() => { throw new Error('boom'); });
    const unsubGood = subscribe(e => { got.push(e); });
    assert.doesNotThrow(() => publish('system', 'system_notice', {}));
    unsubBad();
    unsubGood();
    assert.equal(got.length, 1);
});

test('worker_run events use the existing worker topic replay path', () => {
    const mark = currentSeq();
    broadcast('worker_run_progress', { runId: 'wr_backend_bus', safeSummary: 'ok' });

    const replayed = replaySince(mark);
    assert.equal(replayed.at(-1)?.topic, 'worker');
    assert.equal(replayed.at(-1)?.event, 'worker_run_progress');
    assert.equal(replayed.at(-1)?.data['safeSummary'], 'ok');
});
