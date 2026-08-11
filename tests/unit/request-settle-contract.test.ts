import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resetRequestRegistryForTest,
    admitRequest,
    pendingRequestIds,
    settleAllPending,
    settleOnce,
} from '../../src/orchestrator/request-registry.ts';

// #276 prerequisite. POST /api/message always returned a requestId, but that id
// could not tell a caller when the request was DONE: a successful JWC steer
// emits no completion event for the new id, the collect queue keeps only the
// first id of N merged prompts, and several cancel/drop paths carried no id at
// all. Adding a broadcast per completion site cannot prove exactly-once, so
// settlement goes through one idempotent function and the invariant is checked
// by asserting nothing is left pending.

test.beforeEach(() => { resetRequestRegistryForTest(); });

test('settleOnce is idempotent — a request cannot settle twice', () => {
    admitRequest('r1', 'default');
    assert.equal(settleOnce('r1', 'completed', { text: 'hi' }), true);
    assert.equal(settleOnce('r1', 'failed', { error: 'late' }), false, 'second settle must be a no-op');
    assert.equal(settleOnce('r1', 'cancelled'), false);
    assert.deepEqual(pendingRequestIds(), []);
});

test('settling an unknown or missing id is a harmless no-op', () => {
    assert.equal(settleOnce('never-admitted', 'completed'), false);
    assert.equal(settleOnce(undefined, 'completed'), false);
    assert.deepEqual(pendingRequestIds(), []);
});

test('a merged request settles immediately and names its survivor', () => {
    admitRequest('lead', 'default');
    admitRequest('follower-1', 'default');
    admitRequest('follower-2', 'default');

    // The collect queue runs one turn under `lead`; the others must not wait.
    settleOnce('follower-1', 'merged', { mergedInto: 'lead' });
    settleOnce('follower-2', 'merged', { mergedInto: 'lead' });
    assert.deepEqual(pendingRequestIds(), ['lead']);

    settleOnce('lead', 'completed', { text: 'answer' });
    assert.deepEqual(pendingRequestIds(), [], 'N requests must produce N settlements');
});

test('a steered request settles without waiting for an answer', () => {
    admitRequest('steer-1', 'default');
    // A steer injects into the running turn; no completion event will ever
    // carry this id, so waiting for one would hang until timeout.
    assert.equal(settleOnce('steer-1', 'steered'), true);
    assert.deepEqual(pendingRequestIds(), []);
});

test('settleAllPending drains everything left over', () => {
    admitRequest('a', 'default');
    admitRequest('b', 'default');
    admitRequest('c', 'default');
    assert.equal(settleAllPending('dropped', 'server-shutdown'), 3);
    assert.deepEqual(pendingRequestIds(), [], 'shutdown must not strand a caller');
});

test('settleAllPending can target a single scope', () => {
    admitRequest('x', 'scope-a');
    admitRequest('y', 'scope-b');
    assert.equal(settleAllPending('cancelled', 'stop', 'scope-a'), 1);
    assert.deepEqual(pendingRequestIds(), ['y']);
});

test('re-admitting a live id does not create a duplicate', () => {
    admitRequest('dup', 'default');
    admitRequest('dup', 'default');
    assert.deepEqual(pendingRequestIds(), ['dup']);
    settleOnce('dup', 'completed');
    assert.deepEqual(pendingRequestIds(), []);
});

test('every outcome drains the request', () => {
    for (const outcome of ['completed', 'steered', 'merged', 'failed', 'cancelled', 'dropped', 'skipped'] as const) {
        resetRequestRegistryForTest();
        admitRequest(`r-${outcome}`, 'default');
        assert.equal(settleOnce(`r-${outcome}`, outcome), true, `${outcome} must settle`);
        assert.deepEqual(pendingRequestIds(), [], `${outcome} must leave nothing pending`);
    }
});
