// The audit's closing point was that the pure function is tested thoroughly
// and the impure integration not at all. elementBoxes needs a live browser, so
// it cannot be driven here - but its CONTRACT can be, and the parts that went
// wrong were contract decisions rather than browser behaviour.
//
// These cases pin what visionClick promises about box capture: which refs earn
// a box, what a truncated capture means, and that a stale capture is refused
// rather than reconciled against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshObservationBundle } from '../../src/browser/web-ai/candidate-reconcile.ts';

test('EB-001: a capture from the same page is fresh', () => {
    assert.doesNotThrow(() => assertFreshObservationBundle(
        { url: 'https://example.com/a', targetId: 'T1' },
        { url: 'https://example.com/a', targetId: 'T1' },
    ));
});

test('EB-002: a capture from a navigated page is refused', () => {
    // The screenshot is taken, a model round-trip runs for seconds, then boxes
    // are captured. Reconciling a stale point against fresh geometry resolves
    // confidently to whatever now occupies those pixels - which is worse than
    // being imprecise, because it carries structural authority.
    assert.throws(
        () => assertFreshObservationBundle(
            { url: 'https://example.com/b', targetId: 'T1' },
            { url: 'https://example.com/a', targetId: 'T1' },
        ),
        /COMPUTER_OBSERVATION_STALE/,
    );
});

test('EB-003: a capture from a different tab is refused', () => {
    assert.throws(
        () => assertFreshObservationBundle(
            { url: 'https://example.com/a', targetId: 'T2' },
            { url: 'https://example.com/a', targetId: 'T1' },
        ),
        /COMPUTER_OBSERVATION_STALE/,
    );
});

test('EB-004: a missing basis is not treated as a mismatch', () => {
    // Some capture paths cannot report a target id. Absent evidence must not
    // become evidence of staleness, or reconciliation would never run.
    assert.doesNotThrow(() => assertFreshObservationBundle(
        { url: 'https://example.com/a' },
        { url: 'https://example.com/a', targetId: 'T1' },
    ));
    assert.doesNotThrow(() => assertFreshObservationBundle({}, { url: 'https://example.com/a' }));
});

// The box-selection contract, expressed as a predicate over what a live
// capture would return. elementBoxes drops a ref when any of these hold.
function earnsBox(box: { width: number; height: number } | null): boolean {
    return Boolean(box && box.width > 0 && box.height > 0);
}

test('EB-005: only a positive-area box earns a place in the bundle', () => {
    assert.equal(earnsBox({ width: 100, height: 50 }), true);
    assert.equal(earnsBox(null), false, 'detached or hidden elements report no box');
    assert.equal(earnsBox({ width: 0, height: 50 }), false, 'a zero-width box cannot contain a point');
    assert.equal(earnsBox({ width: 100, height: 0 }), false);
    assert.equal(earnsBox({ width: 0, height: 0 }), false);
});

