// wp11 — regression for the six carry-forward fixes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    elicitationKey,
    getElicitationCompletion,
    setElicitationCompletion,
    resetElicitationRegistry,
} from '../../public/dashboard2/src/chat/elicitation-registry.ts';

test('CF-2: a completed elicitation hydrates from the registry, not fresh state', () => {
    resetElicitationRegistry();
    const identity = { scopeKey: '3506/sess-1', turnId: 'turn-1', segmentId: 'seg-1', slotId: 'slot-1' };
    const key = elicitationKey(identity);
    assert.equal(getElicitationCompletion(key), null, 'nothing before completion');

    setElicitationCompletion(key, { answers: [{ questionId: 'q1', question: 'Pick one', skipped: false, values: ['a'], labels: ['A'] }] });
    const hydrated = getElicitationCompletion(key);
    assert.ok(hydrated, 'completion persisted across a remount');
    assert.equal(hydrated.answers[0]?.questionId, 'q1', 'the SAME elicitation hydrates its completion instead of restarting');

    // A different slot (different elicitation) does not hydrate.
    const other = elicitationKey({ ...identity, slotId: 'slot-2' });
    assert.equal(getElicitationCompletion(other), null, 'a different elicitation has no completion');
    resetElicitationRegistry();
});

test('CF-2: the registry key is stable across virtualization remount', () => {
    const identity = { scopeKey: '3506/sess-1', turnId: 'turn-1', segmentId: 'seg-1', slotId: 'slot-1' };
    assert.equal(elicitationKey(identity), elicitationKey(identity), 'same identity, same key');
    assert.notEqual(elicitationKey(identity), elicitationKey({ ...identity, slotId: 'other' }), 'different slot, different key');
});
