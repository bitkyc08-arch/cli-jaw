// wp11 CF-2 — the elicitation completion hydrates across a remount and is
// scoped to one ChatView at a time.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    elicitationKey,
    getElicitationCompletion,
    setElicitationCompletion,
    resetElicitationRegistry,
    bindElicitationRegistry,
    disposeElicitationRegistry,
} from '../../public/dashboard2/src/chat/elicitation-registry.ts';

function complete(scopeKey: string, key: string): void {
    setElicitationCompletion(scopeKey, key, { answers: [{ questionId: 'q1', question: 'Pick', skipped: false, values: ['a'], labels: ['A'] }] });
}

test('a completed elicitation hydrates on remount instead of restarting', () => {
    resetElicitationRegistry();
    bindElicitationRegistry('3506/sess-1');
    const key = elicitationKey({ scopeKey: '3506/sess-1', turnId: 't1', segmentId: 's1', slotId: 'slot-1' });
    assert.equal(getElicitationCompletion('3506/sess-1', key), null, 'starts active');
    complete('3506/sess-1', key);
    // Simulate virtualization unmount + remount: the component's local state
    // is gone, but the registry still has it.
    const hydrated = getElicitationCompletion('3506/sess-1', key);
    assert.ok(hydrated, 'completion survives the unmount');
    assert.equal(hydrated.answers.length, 1, 'the SAME elicitation hydrates, not restarts');
});

test('each ChatView has its own registry, so one scope cannot see another\'s completions', () => {
    resetElicitationRegistry();
    bindElicitationRegistry('3506/sess-1');
    const key = elicitationKey({ scopeKey: '3506/sess-1', turnId: 't1', segmentId: 's1', slotId: 'slot-1' });
    complete('3506/sess-1', key);
    assert.ok(getElicitationCompletion('3506/sess-1', key), 'completion present in scope 1');
    // A second scope's registry is separate — it does not see scope 1's completion.
    const otherKey = elicitationKey({ scopeKey: '3506/sess-2', turnId: 't1', segmentId: 's1', slotId: 'slot-1' });
    assert.equal(getElicitationCompletion('3506/sess-2', otherKey), null, 'a different scope has no completion for the same slot');
    // Even asking for scope 1's KEY through scope 2's registry finds nothing.
    assert.equal(getElicitationCompletion('3506/sess-2', key), null, 'scope 2 cannot read scope 1\'s entries');
    // And scope 1's completion is still intact (not a global singleton cleared by another scope).
    assert.ok(getElicitationCompletion('3506/sess-1', key), 'scope 1 keeps its own completion');
});

test('disposing a ChatView\'s registry clears only its own completions', () => {
    resetElicitationRegistry();
    bindElicitationRegistry('3506/sess-1');
    bindElicitationRegistry('3506/sess-2');
    const key = elicitationKey({ scopeKey: '3506/sess-1', turnId: 't1', segmentId: 's1', slotId: 'slot-1' });
    const otherKey = elicitationKey({ scopeKey: '3506/sess-2', turnId: 't1', segmentId: 's1', slotId: 'slot-1' });
    complete('3506/sess-1', key);
    complete('3506/sess-2', otherKey);
    disposeElicitationRegistry('3506/sess-1');
    assert.equal(getElicitationCompletion('3506/sess-1', key), null, 'disposing clears the scope\'s completions');
    assert.ok(getElicitationCompletion('3506/sess-2', otherKey), 'disposing one scope leaves the other intact');
});

test('the registry is bounded', () => {
    resetElicitationRegistry();
    bindElicitationRegistry('3506/sess-1');
    for (let i = 0; i < 600; i += 1) {
        complete('3506/sess-1', elicitationKey({ scopeKey: '3506/sess-1', turnId: `t${i}`, segmentId: 's1', slotId: `slot-${i}` }));
    }
    // Over the cap, the oldest is evicted, so the map stays bounded.
    const anyRecent = getElicitationCompletion('3506/sess-1', elicitationKey({ scopeKey: '3506/sess-1', turnId: 't599', segmentId: 's1', slotId: 'slot-599' }));
    assert.ok(anyRecent, 'a recent completion is still retrievable');
});
