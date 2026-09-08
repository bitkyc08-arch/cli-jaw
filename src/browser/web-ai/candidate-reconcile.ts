// Parity catalog 102 (candidate-reconcile). Strict-TS port of agbrowse
// web-ai/candidate-reconcile.mjs. Reconciles a vision-model click candidate
// (a point, optionally a bbox) against the fresh observation bundle's ref boxes:
// point-in-box → ref-click; ambiguous overlap/near-tie → COMPUTER_TARGET_AMBIGUOUS;
// otherwise fall back to a raw coordinate click. Pure (no DOM/CDP) — fully unit-testable.

export interface ReconcileBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ReconcileBundleRef {
    ref: string;
    role: string;
    name: string;
    box?: ReconcileBox;
}

export interface ReconcileObservationBundle {
    refs: ReconcileBundleRef[];
}

export interface ReconcileVisionCandidate {
    point: { x: number; y: number };
    bbox?: ReconcileBox | null;
    confidence?: number;
}

export type ReconcileResult =
    | { action: 'ref'; ref: string; reason: string }
    | { action: 'fail'; code: 'COMPUTER_TARGET_AMBIGUOUS'; reason: string }
    | { action: 'coordinate'; reason: string };

export interface ReconcileInput {
    candidate: ReconcileVisionCandidate;
    bundle: ReconcileObservationBundle;
    maxDistance?: number;
}

/** Tie-break margin (px): the nearest box must beat the runner-up by this much to win. */
const NEAR_TIE_MARGIN = 8;

export function reconcileVisionCandidate(input: ReconcileInput): ReconcileResult {
    const maxDistance = input.maxDistance ?? 32;
    const refs = Array.isArray(input.bundle?.refs)
        ? input.bundle.refs.filter((r): r is ReconcileBundleRef & { box: ReconcileBox } => Boolean(r.box))
        : [];
    const point = input.candidate.point;

    const containing = refs.filter((r) => contains(r.box, point));
    if (containing.length === 1) {
        return { action: 'ref', ref: containing[0]!.ref, reason: 'candidate_center_inside_ref_box' };
    }
    if (containing.length > 1) {
        return { action: 'fail', code: 'COMPUTER_TARGET_AMBIGUOUS', reason: 'multiple_ref_boxes_contain_candidate' };
    }

    const nearby = refs
        .map((r) => ({ ref: r.ref, distance: distanceToBoxEdge(point, r.box) }))
        .filter((r) => r.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance);
    if (nearby.length === 1 || (nearby.length > 1 && nearby[0]!.distance + NEAR_TIE_MARGIN < nearby[1]!.distance)) {
        return { action: 'ref', ref: nearby[0]!.ref, reason: 'candidate_center_near_ref_box' };
    }
    if (nearby.length > 1) {
        return { action: 'fail', code: 'COMPUTER_TARGET_AMBIGUOUS', reason: 'multiple_nearby_ref_boxes' };
    }
    return { action: 'coordinate', reason: 'no_matching_ref_box' };
}

export interface ObservationBasis {
    url?: string;
    targetId?: string;
}

/**
 * Guard against acting on a stale observation: if the bundle was captured on a
 * different URL/target than the live page, throw COMPUTER_OBSERVATION_STALE.
 */
export function assertFreshObservationBundle(
    bundle: { basis?: ObservationBasis } & ObservationBasis,
    current: ObservationBasis,
): void {
    const basis = bundle.basis || bundle;
    if (basis.url && current.url && basis.url !== current.url) {
        throw new Error('COMPUTER_OBSERVATION_STALE: observation URL does not match current page');
    }
    if (basis.targetId && current.targetId && basis.targetId !== current.targetId) {
        throw new Error('COMPUTER_OBSERVATION_STALE: observation targetId does not match current page');
    }
}

function contains(box: ReconcileBox | undefined, point: { x: number; y: number }): boolean {
    if (!box) return false;
    return (
        point.x >= box.x &&
        point.y >= box.y &&
        point.x <= box.x + box.width &&
        point.y <= box.y + box.height
    );
}

/**
 * Distance from a point to the nearest edge of a box, zero when inside.
 *
 * Measuring to the CENTRE penalises large elements: a 400px-wide toolbar
 * button has a centre 200px away from its own edge, so a candidate a few
 * pixels outside it would score as far away while a tiny icon nearby scored
 * as close. What "near this element" means is proximity to the element, not
 * to its midpoint.
 */
function distanceToBoxEdge(point: { x: number; y: number }, box: ReconcileBox | undefined): number {
    if (!box) return Number.POSITIVE_INFINITY;
    const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
    const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
    return Math.hypot(dx, dy);
}
