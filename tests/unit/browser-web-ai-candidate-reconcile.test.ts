import test from 'node:test';
import assert from 'node:assert/strict';
import {
    reconcileVisionCandidate,
    assertFreshObservationBundle,
} from '../../src/browser/web-ai/candidate-reconcile.ts';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

// 102 candidate-reconcile: vision candidate → ref-box vs coordinate decision.
test('BWAI-RECONCILE-001: a single containing ref box → ref click', () => {
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 50, y: 50 } },
        bundle: { refs: [{ ref: 'e1', role: 'button', name: 'Send', box: box(0, 0, 100, 100) }] },
    });
    assert.deepEqual(r, { action: 'ref', ref: 'e1', reason: 'candidate_center_inside_ref_box' });
});

test('BWAI-RECONCILE-002: multiple boxes contain the point → ambiguous', () => {
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 50, y: 50 } },
        bundle: {
            refs: [
                { ref: 'e1', role: 'button', name: 'A', box: box(0, 0, 100, 100) },
                { ref: 'e2', role: 'button', name: 'B', box: box(40, 40, 100, 100) },
            ],
        },
    });
    assert.equal(r.action, 'fail');
    assert.equal((r as { code: string }).code, 'COMPUTER_TARGET_AMBIGUOUS');
    assert.equal(r.reason, 'multiple_ref_boxes_contain_candidate');
});

test('BWAI-RECONCILE-003: a single nearby box within maxDistance → ref click', () => {
    const r = reconcileVisionCandidate({
        // Distance runs to the nearest EDGE, so this point is 10px out, not
        // the ~60px its centre would have been. The wide maxDistance is
        // historical, from when distance was measured to the centre.
        candidate: { point: { x: 110, y: 50 } },
        bundle: { refs: [{ ref: 'e1', role: 'button', name: 'A', box: box(0, 0, 100, 100) }] },
        maxDistance: 100,
    });
    assert.deepEqual(r, { action: 'ref', ref: 'e1', reason: 'candidate_center_near_ref_box' });
});

test('BWAI-RECONCILE-004: nearest beats runner-up by > tie margin → ref click', () => {
    // point (35,10) is inside no box. Edge distances: e1 is 15 away, e2 is
    // ~42.7 — a gap of ~28, comfortably past the 8px tie margin.
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 35, y: 10 } },
        bundle: {
            refs: [
                { ref: 'e1', role: 'button', name: 'A', box: box(0, 0, 20, 20) },
                { ref: 'e2', role: 'button', name: 'B', box: box(50, 50, 20, 20) },
            ],
        },
        maxDistance: 100,
    });
    assert.deepEqual(r, { action: 'ref', ref: 'e1', reason: 'candidate_center_near_ref_box' });
});

test('BWAI-RECONCILE-005: two near boxes inside the tie margin → ambiguous', () => {
    // point (50,30): e1 center (30,30) dist 20; e2 center (70,30) dist 20 — equal, gap 0 < 8
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 50, y: 30 } },
        bundle: {
            refs: [
                { ref: 'e1', role: 'button', name: 'A', box: box(20, 20, 20, 20) },
                { ref: 'e2', role: 'button', name: 'B', box: box(60, 20, 20, 20) },
            ],
        },
        maxDistance: 100,
    });
    assert.equal(r.action, 'fail');
    assert.equal(r.reason, 'multiple_nearby_ref_boxes');
});

test('BWAI-RECONCILE-006: no box contains or is near → raw coordinate fallback', () => {
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 500, y: 500 } },
        bundle: { refs: [{ ref: 'e1', role: 'button', name: 'A', box: box(0, 0, 20, 20) }] },
    });
    assert.deepEqual(r, { action: 'coordinate', reason: 'no_matching_ref_box' });
});

test('BWAI-RECONCILE-007: refs without boxes are ignored', () => {
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 5, y: 5 } },
        bundle: { refs: [{ ref: 'e1', role: 'button', name: 'A' }] },
    });
    assert.equal(r.action, 'coordinate');
});

// assertFreshObservationBundle — stale guard.
test('BWAI-RECONCILE-008: stale URL throws', () => {
    assert.throws(
        () => assertFreshObservationBundle({ url: 'https://a/c/1' }, { url: 'https://a/c/2' }),
        /COMPUTER_OBSERVATION_STALE/,
    );
});

test('BWAI-RECONCILE-009: stale targetId throws; matching basis passes', () => {
    assert.throws(
        () => assertFreshObservationBundle({ targetId: 'T1' }, { targetId: 'T2' }),
        /COMPUTER_OBSERVATION_STALE/,
    );
    // nested basis + matching → no throw
    assert.doesNotThrow(() =>
        assertFreshObservationBundle({ basis: { url: 'https://a/c/1', targetId: 'T1' } }, { url: 'https://a/c/1', targetId: 'T1' }),
    );
});
