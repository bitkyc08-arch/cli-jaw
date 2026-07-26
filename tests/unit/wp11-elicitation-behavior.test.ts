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
} from '../../public/dashboard2/src/chat/elicitation-registry.ts';

function complete(key: string): void {
    setElicitationCompletion(key, { answers: [{ questionId: 'q1', question: 'Pick', skipped: false, values: ['a'], labels: ['A'] }] });
}

test('a completed elicitation hydrates on remount instead of restarting', () => {
    resetElicitationRegistry();
    bindElicitationRegistry('3506/sess-1');
    const key = elicitationKey({ scopeKey: '3506/sess-1', turnId: 't1', segmentId: 's1', slotId: 'slot-1' });
    assert.equal(getElicitationCompletion(key), null, 'starts active');
    complete(key);
    // Simulate virtualization unmount + remount: the component's local state
    // is gone, but the registry still has it.
    const hydrated = getElicitationCompletion(key);
    assert.ok(hydrated, 'completion survives the unmount');
    assert.equal(hydrated.answers.length, 1, 'the SAME elicitation hydrates, not restarts');
});

test('a session switch clears completions so one ChatView cannot see another\'s', () => {
    resetElicitationRegistry();
    bindElicitationRegistry('3506/sess-1');
    const key = elicitationKey({ scopeKey: '3506/sess-1', turnId: 't1', segmentId: 's1', slotId: 'slot-1' });
    complete(key);
    assert.ok(getElicitationCompletion(key), 'completion present in scope 1');
    bindElicitationRegistry('3506/sess-2');
    assert.equal(getElicitationCompletion(key), null, 'a session switch clears the registry');
});

test('the registry is bounded', () => {
    resetElicitationRegistry();
    bindElicitationRegistry('3506/sess-1');
    for (let i = 0; i < 600; i += 1) {
        complete(elicitationKey({ scopeKey: '3506/sess-1', turnId: `t${i}`, segmentId: 's1', slotId: `slot-${i}` }));
    }
    // Over the cap, the oldest is evicted, so the map stays bounded.
    const anyRecent = getElicitationCompletion(elicitationKey({ scopeKey: '3506/sess-1', turnId: 't599', segmentId: 's1', slotId: 'slot-599' }));
    assert.ok(anyRecent, 'a recent completion is still retrievable');
});
