import test from 'node:test';
import assert from 'node:assert/strict';
import { beginSteerInput, cancelSteerInputs, cancelAllSteerInputs } from '../../src/agent/steer-input-guard.ts';

test.afterEach(cancelAllSteerInputs);
test('Stop invalidates all pending inputs in its scope, not another scope', () => {
    const a = beginSteerInput('a'), b = beginSteerInput('a'), other = beginSteerInput('b');
    assert.equal(a.isCancelled(), false); cancelSteerInputs('a');
    assert.equal(a.isCancelled(), true); assert.equal(b.isCancelled(), true); assert.equal(other.isCancelled(), false);
    a.release(); b.release(); other.release();
});
test('Stop after the main run disappears still invalidates a pending input', () => {
    const input = beginSteerInput('finished-run');
    // Guard ownership does not depend on the lifetime of activeMainProcesses.
    cancelSteerInputs('finished-run'); assert.equal(input.isCancelled(), true); input.release();
});
test('fresh input after Stop is admitted; old release cannot remove its cancellation set', () => {
    const old = beginSteerInput('a'); cancelSteerInputs('a');
    const next = beginSteerInput('a'); old.release(); old.release();
    assert.equal(next.isCancelled(), false);
    cancelSteerInputs('a'); assert.equal(next.isCancelled(), true); next.release();
});
test('normal release is idempotent and leaves other pending inputs cancellable', () => {
    const released = beginSteerInput('a'), pending = beginSteerInput('a');
    released.release(); released.release(); assert.equal(released.isCancelled(), true);
    assert.equal(pending.isCancelled(), false); cancelSteerInputs('a'); assert.equal(pending.isCancelled(), true); pending.release();
});
test('aggregate Stop invalidates pending scopes and does not block later new input', () => {
    const a = beginSteerInput('a'), b = beginSteerInput('b'); cancelAllSteerInputs();
    assert.equal(a.isCancelled(), true); assert.equal(b.isCancelled(), true);
    const next = beginSteerInput('a'); a.release(); b.release(); assert.equal(next.isCancelled(), false);
    cancelAllSteerInputs(); assert.equal(next.isCancelled(), true); next.release();
});
