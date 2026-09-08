// The option this replaces re-ran the identical query against the identical
// screenshot and discarded the coordinates, keeping only whether the second
// answer still found something. Same input, same question - the only way it
// could fail was model non-determinism.
//
// Its test asserted the string 'verifyBeforeClick' appeared in the source, so
// a guard that guarded nothing passed a suite that checked nothing. These
// cases assert what the geometry actually does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cropAroundPoint,
    judgeVerification,
    VERIFY_CROP,
    VERIFY_DRIFT_LIMIT,
} from '../../src/browser/verify-candidate.ts';

const viewport = { width: 1280, height: 800 };

test('VER-001: the crop is centred on the candidate', () => {
    const c = cropAroundPoint({ x: 640, y: 400 }, viewport);
    assert.equal(c.width, VERIFY_CROP.width);
    assert.equal(c.height, VERIFY_CROP.height);
    assert.equal(c.x + c.width / 2, 640);
    assert.equal(c.y + c.height / 2, 400);
});

test('VER-002: a candidate near an edge still gets a full-size crop', () => {
    // Shrinking instead of shifting would make the drift threshold mean
    // something different near the edges than in the middle.
    const topLeft = cropAroundPoint({ x: 5, y: 5 }, viewport);
    assert.deepEqual(topLeft, { x: 0, y: 0, width: 280, height: 200 });

    const bottomRight = cropAroundPoint({ x: 1275, y: 795 }, viewport);
    assert.equal(bottomRight.width, 280);
    assert.equal(bottomRight.height, 200);
    assert.equal(bottomRight.x + bottomRight.width, 1280, 'flush against the right edge');
    assert.equal(bottomRight.y + bottomRight.height, 800);
});

test('VER-003: a viewport smaller than the crop clamps the crop', () => {
    const c = cropAroundPoint({ x: 50, y: 50 }, { width: 100, height: 80 });
    assert.deepEqual(c, { x: 0, y: 0, width: 100, height: 80 });
});

test('VER-004: an answer at the crop centre agrees', () => {
    const crop = { x: 500, y: 300, width: 280, height: 200 };
    const o = judgeVerification({ x: 140, y: 100 }, crop);
    assert.equal(o.agreed, true);
    assert.deepEqual(o.agreed && o.point, { x: 640, y: 400 }, 'and comes back in page coordinates');
    assert.equal(o.agreed && o.drift, 0);
});

test('VER-004b: drift is measured from the CANDIDATE, not the crop centre', () => {
    // These coincide in the middle of a viewport but not near an edge, where
    // the crop clamps. A candidate 5px from the left sits 5px into its crop
    // while the crop centre is 140px in — measuring from the centre there
    // refuses a second answer that re-found the exact same point, which is the
    // case that should agree most strongly.
    const candidate = { x: 5, y: 400 };
    const crop = cropAroundPoint(candidate, viewport);
    assert.equal(crop.x, 0, 'the crop is clamped against the left edge');

    const samePoint = { x: candidate.x - crop.x, y: candidate.y - crop.y };
    const o = judgeVerification(samePoint, crop, candidate);
    assert.equal(o.agreed, true, 're-finding the same point must agree');
    assert.equal(o.agreed && o.drift, 0);

    // A genuinely different answer in that same clamped crop still disagrees.
    const far = judgeVerification({ x: 200, y: 100 }, crop, candidate);
    assert.equal(far.agreed, false);
});

test('VER-005: the second look REPLACES the first estimate', () => {
    // The old option kept the original coordinates no matter what the second
    // answer said. A verification that cannot move the click is decoration.
    const crop = { x: 500, y: 300, width: 280, height: 200 };
    const o = judgeVerification({ x: 160, y: 110 }, crop);
    assert.equal(o.agreed, true);
    assert.deepEqual(o.agreed && o.point, { x: 660, y: 410 }, 'not the crop centre');
});

test('VER-006: an answer drifting to the crop edge disagrees', () => {
    // Two answers pointing at different things. The disagreement matters more
    // than either one.
    const crop = { x: 0, y: 0, width: 280, height: 200 };
    const o = judgeVerification({ x: 275, y: 100 }, crop);
    assert.equal(o.agreed, false);
    assert.match(o.agreed ? '' : o.reason, /drifted \d+% from the original candidate/);
});

test('VER-007: a target absent from the crop disagrees', () => {
    // The target is not where we thought it was - which is the first answer
    // being wrong, and exactly what this exists to catch.
    const o = judgeVerification(null, { x: 0, y: 0, width: 280, height: 200 });
    assert.equal(o.agreed, false);
    assert.match(o.agreed ? '' : o.reason, /not in the verification crop/);
});

test('VER-008: the drift threshold is symmetric and applies per axis', () => {
    const crop = { x: 0, y: 0, width: 200, height: 200 };
    const limit = VERIFY_DRIFT_LIMIT * 200; // 90px from centre

    // Just inside, on each axis and each direction.
    for (const p of [
        { x: 100 + limit - 1, y: 100 },
        { x: 100 - limit + 1, y: 100 },
        { x: 100, y: 100 + limit - 1 },
        { x: 100, y: 100 - limit + 1 },
    ]) {
        assert.equal(judgeVerification(p, crop).agreed, true, `${p.x},${p.y} should agree`);
    }

    // Just outside, same four directions.
    for (const p of [
        { x: 100 + limit + 1, y: 100 },
        { x: 100 - limit - 1, y: 100 },
        { x: 100, y: 100 + limit + 1 },
        { x: 100, y: 100 - limit - 1 },
    ]) {
        assert.equal(judgeVerification(p, crop).agreed, false, `${p.x},${p.y} should disagree`);
    }
});

test('VER-009: drift is a fraction, so the threshold means the same at any crop size', () => {
    // Proportionally identical answers must be judged identically, whatever
    // the crop's absolute size. 40px out of 100 and 400 out of 1000 are the
    // same displacement, and both sit inside the 45% threshold.
    const small = judgeVerification({ x: 90, y: 50 }, { x: 0, y: 0, width: 100, height: 100 });
    const large = judgeVerification({ x: 900, y: 500 }, { x: 0, y: 0, width: 1000, height: 1000 });
    assert.equal(small.agreed, true);
    assert.equal(large.agreed, true);
    assert.equal(small.agreed && small.drift, 0.4);
    assert.equal(large.agreed && large.drift, 0.4);

    // And the same holds past the threshold.
    const smallOut = judgeVerification({ x: 98, y: 50 }, { x: 0, y: 0, width: 100, height: 100 });
    const largeOut = judgeVerification({ x: 980, y: 500 }, { x: 0, y: 0, width: 1000, height: 1000 });
    assert.equal(smallOut.agreed, false);
    assert.equal(largeOut.agreed, false);
    assert.equal(smallOut.drift, largeOut.drift);
});

test('VER-010: a caller can tighten or loosen the threshold', () => {
    const crop = { x: 0, y: 0, width: 200, height: 200 };
    const point = { x: 170, y: 100 }; // 35% drift
    assert.equal(judgeVerification(point, crop).agreed, true);
    assert.equal(judgeVerification(point, crop, undefined, 0.3).agreed, false);
});
