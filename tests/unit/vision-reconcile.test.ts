// candidate-reconcile.ts sat in this tree with no production caller because
// nothing supplied element boxes. These cases pin the decisions the vision
// path now makes with them, in the coordinate space it actually uses: CSS
// pixels, after DPR correction and clip offset.
//
// The point of reconciliation is that a coordinate is a frozen guess while a
// ref survives scroll, reflow and animation. When the point lands inside
// exactly one element, clicking that element is strictly better than clicking
// where it happened to be.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileVisionCandidate } from '../../src/browser/web-ai/candidate-reconcile.ts';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const ref = (name: string, b: ReturnType<typeof box>) => ({ ref: name, role: 'button', name, box: b });

test('RC-001: a point inside exactly one element resolves to that ref', () => {
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 50, y: 25 } },
        bundle: { refs: [ref('e1', box(0, 0, 100, 50)), ref('e2', box(200, 0, 100, 50))] },
    });
    assert.equal(r.action, 'ref');
    assert.equal(r.action === 'ref' && r.ref, 'e1');
});

test('RC-002: overlapping elements are ambiguous, not a guess', () => {
    // A modal over a button is the classic case. Picking one silently is how
    // an agent clicks the thing it did not mean.
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 50, y: 25 } },
        bundle: { refs: [ref('e1', box(0, 0, 100, 50)), ref('e2', box(40, 20, 100, 50))] },
    });
    assert.equal(r.action, 'fail');
    assert.equal(r.action === 'fail' && r.code, 'COMPUTER_TARGET_AMBIGUOUS');
});

test('RC-003: a near miss snaps to the nearest element', () => {
    // Vision output is approximate; a few pixels outside the border is still
    // that button.
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 52, y: 27 } },
        bundle: { refs: [ref('e1', box(0, 0, 100, 50))] },
    });
    assert.equal(r.action, 'ref');
    assert.equal(r.action === 'ref' && r.reason, 'candidate_center_inside_ref_box');
});

test('RC-004: a point far from everything falls back to a coordinate', () => {
    // Canvas, WebGL and custom renders have no ref. That is exactly when a
    // coordinate click is the right answer rather than a failure.
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 900, y: 900 } },
        bundle: { refs: [ref('e1', box(0, 0, 100, 50))] },
    });
    assert.equal(r.action, 'coordinate');
    assert.equal(r.action === 'coordinate' && r.reason, 'no_matching_ref_box');
});

test('RC-005: two equally near elements are ambiguous', () => {
    // Without a tie margin this would pick whichever sorted first.
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 100, y: 25 } },
        bundle: { refs: [ref('e1', box(70, 15, 20, 20)), ref('e2', box(110, 15, 20, 20))] },
    });
    assert.equal(r.action, 'fail');
});

test('RC-006: an empty bundle is a coordinate click, not an error', () => {
    const r = reconcileVisionCandidate({ candidate: { point: { x: 10, y: 10 } }, bundle: { refs: [] } });
    assert.equal(r.action, 'coordinate');
});

test('RC-007: refs without boxes are ignored rather than trusted', () => {
    // elementBoxes omits detached, hidden and zero-area elements. A ref with
    // no box carries no geometry, so it cannot contain anything.
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 50, y: 25 } },
        bundle: { refs: [{ ref: 'e1', role: 'button', name: 'ghost' }, ref('e2', box(0, 0, 100, 50))] },
    });
    assert.equal(r.action, 'ref');
    assert.equal(r.action === 'ref' && r.ref, 'e2');
});

test('RC-008: the search radius is bounded', () => {
    // A distant element must not capture a click just by being the only one
    // on the page.
    const near = reconcileVisionCandidate({
        candidate: { point: { x: 120, y: 25 } },
        bundle: { refs: [ref('e1', box(0, 0, 100, 50))] },
    });
    assert.equal(near.action, 'ref', 'just outside the border still counts');

    const far = reconcileVisionCandidate({
        candidate: { point: { x: 400, y: 25 } },
        bundle: { refs: [ref('e1', box(0, 0, 100, 50))] },
    });
    assert.equal(far.action, 'coordinate', 'far away does not');
});

test('RC-009: a caller can widen or narrow the radius', () => {
    const bundle = { refs: [ref('e1', box(0, 0, 100, 50))] };
    const point = { x: 200, y: 25 };
    assert.equal(reconcileVisionCandidate({ candidate: { point }, bundle }).action, 'coordinate');
    assert.equal(reconcileVisionCandidate({ candidate: { point }, bundle, maxDistance: 200 }).action, 'ref');
});

test('RC-010: edge distance trades a wrong click for a refusal near a toolbar', () => {
    // This is the real consequence of measuring to the edge, and it is not a
    // pure win. A point between a wide toolbar and a small icon used to
    // resolve decisively to the icon, because the toolbar's centre was far
    // away. By edge distance they are equidistant, which the tie margin turns
    // into a refusal.
    //
    // A refusal is the better failure - the previous decisiveness was an
    // artifact of element width, not evidence about the target - but it IS a
    // behaviour change and belongs in the record rather than in a footnote.
    const point = { x: 810, y: 30 };
    const bundle = {
        refs: [
            ref('toolbar', box(0, 0, 800, 60)),
            ref('icon', box(820, 20, 20, 20)),
        ],
    };
    const r = reconcileVisionCandidate({ candidate: { point }, bundle });
    assert.equal(r.action, 'fail', 'equidistant neighbours must not be guessed between');
    assert.equal(r.action === 'fail' && r.code, 'COMPUTER_TARGET_AMBIGUOUS');
});

test('RC-011: a large element does not capture points outside itself', () => {
    // Containment is checked before distance and is unchanged, so widening the
    // notion of "near" cannot let a big container swallow a point that is
    // plainly inside a small element.
    const r = reconcileVisionCandidate({
        candidate: { point: { x: 500, y: 300 } },
        bundle: { refs: [ref('page', box(0, 0, 1200, 800)), ref('button', box(480, 290, 40, 20))] },
    });
    assert.equal(r.action, 'fail', 'nested boxes both containing the point are ambiguous');
});
