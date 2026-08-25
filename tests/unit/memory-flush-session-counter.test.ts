// #454: one session could spend the flush budget another session had filled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countTurnForFlush, resetFlushCountersForTest } from '../../src/agent/memory-flush-controller.ts';

test('FLUSH-454a: a session earns its own flush', () => {
    resetFlushCountersForTest();
    for (let i = 0; i < 9; i++) {
        assert.equal(countTurnForFlush('a', 10), false, `turn ${i + 1} should not fire yet`);
    }
    assert.equal(countTurnForFlush('a', 10), true, 'the tenth turn of A fires for A');
});

test('FLUSH-454b: another session cannot spend it', () => {
    // The reported failure: nine turns in A, one in B, and the flush fired —
    // summarising B, whose single turn had nothing to summarise, while A went
    // back to zero unsummarised.
    resetFlushCountersForTest();
    for (let i = 0; i < 9; i++) countTurnForFlush('a', 10);

    assert.equal(countTurnForFlush('b', 10), false,
        "B's first turn must not cash in the budget A filled");
    assert.equal(countTurnForFlush('a', 10), true,
        'A still reaches its own threshold on its own tenth turn');
});

test('FLUSH-454c: firing resets only the session that fired', () => {
    resetFlushCountersForTest();
    for (let i = 0; i < 9; i++) countTurnForFlush('a', 10);
    for (let i = 0; i < 5; i++) countTurnForFlush('b', 10);

    assert.equal(countTurnForFlush('a', 10), true);
    // B kept its five; if the reset were global it would be starting over.
    for (let i = 0; i < 4; i++) {
        assert.equal(countTurnForFlush('b', 10), false);
    }
    assert.equal(countTurnForFlush('b', 10), true, 'B reaches ten at its tenth turn, not its fifteenth');
});

test('FLUSH-454d: the session map stays bounded', () => {
    // Keyed by session id on a long-lived host, so it needs a ceiling like the
    // deferred-flush set has.
    resetFlushCountersForTest();
    for (let i = 0; i < 500; i++) countTurnForFlush(`session-${i}`, 10);
    // No direct size accessor; prove it indirectly — an early session was evicted
    // and therefore starts counting again rather than being near its threshold.
    assert.equal(countTurnForFlush('session-0', 2), false,
        'an evicted session restarts from zero instead of retaining stale credit');
});

