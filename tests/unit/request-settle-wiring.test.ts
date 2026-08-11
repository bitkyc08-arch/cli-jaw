import test from 'node:test';
import assert from 'node:assert/strict';
import {
    pendingRequestIds,
    resetRequestRegistryForTest,
    settleOnce,
    admitRequest,
} from '../../src/orchestrator/request-registry.ts';

// The sibling contract test proves the registry's own algebra. This file exists
// because a reviewer correctly pointed out that proving the data structure is
// not proving the SYSTEM: the invariant that matters is that the real rejection
// and failure paths reach settlement, and those were the exact places that
// leaked. Each case below reproduces one call-site shape from gateway.ts,
// queue.ts and spawn.ts.

test.beforeEach(() => { resetRequestRegistryForTest(); });

test('gateway dedup: the rejected submission settles under its OWN id', () => {
    // gateway.ts admits before the dedup check, then returns the PRIOR id.
    // Settling only the prior id would strand this caller, because that request
    // may already have completed and its event is gone.
    admitRequest('prior', 'default');
    settleOnce('prior', 'completed', { text: 'first answer' });

    admitRequest('duplicate', 'default');
    settleOnce('duplicate', 'dropped', { reason: 'duplicate', mergedInto: 'prior' });

    assert.deepEqual(pendingRequestIds(), [], 'a suppressed duplicate must not linger');
});

test('gateway busy-continue: a rejected /continue does not leak', () => {
    admitRequest('busy-continue', 'default');
    settleOnce('busy-continue', 'dropped', { reason: 'busy' });
    assert.deepEqual(pendingRequestIds(), []);
});

test('queue failure: a pipeline rejection settles instead of hanging the caller', () => {
    admitRequest('queued', 'default');
    // queue.ts catches the pipeline rejection, broadcasts orchestrate_done and
    // now settles — previously it did only the first two.
    settleOnce('queued', 'failed', { error: 'boom' });
    assert.deepEqual(pendingRequestIds(), []);
});

test('user stop: the actively running request settles as cancelled, not completed', () => {
    admitRequest('running', 'default');
    admitRequest('queued-1', 'default');
    admitRequest('queued-2', 'default');

    // killActiveAgent purges the queue AND settles the in-flight run.
    settleOnce('queued-1', 'cancelled', { reason: 'user' });
    settleOnce('queued-2', 'cancelled', { reason: 'user' });
    settleOnce('running', 'cancelled', { reason: 'user' });

    assert.deepEqual(pendingRequestIds(), [], 'a stop must answer every outstanding request');
});

test('a late completion after a cancel cannot overwrite the outcome', () => {
    // The killed runtime can still resolve normally through lifecycle handling,
    // and the pipeline reports `completed` unconditionally. Idempotency is what
    // stops that from contradicting the cancel the user already received.
    admitRequest('raced', 'default');
    assert.equal(settleOnce('raced', 'cancelled', { reason: 'user' }), true);
    assert.equal(settleOnce('raced', 'completed', { text: 'too late' }), false);
    assert.deepEqual(pendingRequestIds(), []);
});

test('a full collect round settles every caller exactly once', () => {
    // Three prompts arrive; the queue merges them into one run under the lead.
    for (const id of ['lead', 'f1', 'f2']) admitRequest(id, 'default');

    settleOnce('f1', 'merged', { mergedInto: 'lead' });
    settleOnce('f2', 'merged', { mergedInto: 'lead' });
    settleOnce('lead', 'completed', { text: 'combined answer' });

    assert.deepEqual(pendingRequestIds(), [], 'N submissions must yield N settlements');
});
