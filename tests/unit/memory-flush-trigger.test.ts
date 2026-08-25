// The flush trigger is global: N assistant turns anywhere fire ONE flush.
//
// Replaces memory-flush-session-counter.test.ts, whose FLUSH-454 cases asserted the
// opposite (a per-session counter). #454 is still fixed, but by making the flush TARGET
// global rather than the trigger — see memory-merged-flush.test.ts, which proves the
// session that filled the counter is summarised alongside the one that spent it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countTurnForFlush, resetFlushCountersForTest } from '../../src/agent/memory-flush-controller.ts';

test('FLUSH-G1: the tenth turn fires, the nine before it do not', () => {
    resetFlushCountersForTest();
    for (let i = 0; i < 9; i++) {
        assert.equal(countTurnForFlush(10), false, `turn ${i + 1} must not fire`);
    }
    assert.equal(countTurnForFlush(10), true, 'the tenth turn fires');
});

test('FLUSH-G2: turns add up regardless of which session they came from', () => {
    // #454 inverted. It asked that B's single turn not spend the budget A filled; the
    // answer here is not separate budgets but summarising BOTH, so the tenth turn fires
    // no matter whose it was. That A is actually included is proved in the merged-flush
    // suite — this only fixes the cadence.
    resetFlushCountersForTest();
    for (let i = 0; i < 9; i++) countTurnForFlush(10);
    assert.equal(countTurnForFlush(10), true, 'a turn from any session completes the count');
});

test('FLUSH-G3: firing resets the counter, so the next flush needs a full cycle', () => {
    resetFlushCountersForTest();
    for (let i = 0; i < 10; i++) countTurnForFlush(10);
    for (let i = 0; i < 9; i++) {
        assert.equal(countTurnForFlush(10), false, `turn ${i + 1} after a flush must not fire`);
    }
    assert.equal(countTurnForFlush(10), true);
});

test('FLUSH-G4: a threshold of 1 fires every turn', () => {
    // The counter increments before comparing, so an off-by-one here would either never
    // fire or fire twice for one turn.
    resetFlushCountersForTest();
    for (let i = 0; i < 3; i++) assert.equal(countTurnForFlush(1), true);
});
