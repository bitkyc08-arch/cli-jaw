/**
 * src/browser/verify-candidate.ts — a second look that can actually disagree.
 *
 * The option this replaces re-ran the identical query against the identical
 * screenshot and then discarded the coordinates, keeping only whether the
 * second answer still found something. Same input, same question: the only way
 * it could fail was model non-determinism, and the only thing it reliably
 * bought was a second round-trip. Its test asserted the string
 * `verifyBeforeClick` appeared in the source, so a guard that guarded nothing
 * passed a suite that checked nothing.
 *
 * A verification that can disagree has to change the input. Cropping tightly
 * around the candidate and asking again does that: the target now dominates
 * the frame, so a model that was guessing has to guess differently, and an
 * answer drifting to the crop's edge is evidence the first answer was wrong.
 *
 * Geometry only. The capture and the model call belong to the caller.
 */

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Point & Size;

/** Default crop around a candidate, in CSS pixels. */
export const VERIFY_CROP: Size = { width: 280, height: 200 };

/**
 * How far from the crop centre a second answer may land, as a fraction of the
 * crop. Beyond this the two answers are pointing at different things, and the
 * disagreement matters more than either one.
 */
export const VERIFY_DRIFT_LIMIT = 0.45;

/**
 * A crop centred on the candidate, clamped inside the viewport.
 *
 * Clamping shifts the rectangle rather than shrinking it, so a candidate near
 * an edge still gets a full-size crop and the same drift threshold means the
 * same thing everywhere.
 */
export function cropAroundPoint(point: Point, viewport: Size, size: Size = VERIFY_CROP): Rect {
    const width = Math.min(size.width, viewport.width);
    const height = Math.min(size.height, viewport.height);
    const x = Math.max(0, Math.min(Math.round(point.x - width / 2), viewport.width - width));
    const y = Math.max(0, Math.min(Math.round(point.y - height / 2), viewport.height - height));
    return { x, y, width, height };
}

export type VerifyOutcome =
    | { agreed: true; point: Point; drift: number }
    | { agreed: false; reason: string; drift?: number };

/**
 * Judge a second answer taken inside `crop`.
 *
 * `localPoint` is where the re-run landed within the crop, in CSS pixels
 * relative to the crop's own origin. The returned point is back in page
 * coordinates, so a caller that agrees can use it directly — the second look
 * replaces the first estimate rather than merely blessing it.
 *
 * Drift is measured from the ORIGINAL CANDIDATE, not from the crop centre.
 * Those coincide in the middle of a viewport but not near an edge, where the
 * crop clamps: a candidate 5px from the left sits 5px into its crop while the
 * crop centre is 140px in. Measuring from the centre there would refuse a
 * second answer that re-found the exact same point — the one case that should
 * agree most strongly.
 */
export function judgeVerification(
    localPoint: Point | null,
    crop: Rect,
    candidate?: Point,
    driftLimit = VERIFY_DRIFT_LIMIT,
): VerifyOutcome {
    // The target is not in a crop centred on where we thought it was. That is
    // the first answer being wrong, which is exactly what this is for.
    if (!localPoint) return { agreed: false, reason: 'the target was not in the verification crop' };

    // Fall back to the crop centre only when no candidate was supplied, which
    // is the same point whenever the crop was not clamped.
    const cx = candidate ? candidate.x - crop.x : crop.width / 2;
    const cy = candidate ? candidate.y - crop.y : crop.height / 2;
    const dx = Math.abs(localPoint.x - cx) / crop.width;
    const dy = Math.abs(localPoint.y - cy) / crop.height;
    const drift = Math.max(dx, dy);

    if (drift > driftLimit) {
        return {
            agreed: false,
            reason: `the second answer drifted ${Math.round(drift * 100)}% from the original candidate`,
            drift,
        };
    }

    return {
        agreed: true,
        point: { x: crop.x + localPoint.x, y: crop.y + localPoint.y },
        drift,
    };
}
