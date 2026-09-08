/**
 * src/browser/grounding-candidate.ts — the shape a grounding answer takes, and
 * how it is recovered from model output.
 *
 * Two things were wrong with the previous extractor, and both are structural
 * rather than cosmetic.
 *
 * It matched with `/\{[^{}]*"found"...\}/`. The `[^{}]*` class cannot cross a
 * nested object, so a well-formed `{"found":true,"bbox":{...},"point":{...}}`
 * could never match at all — the richer schema was unreachable no matter what
 * the model returned. It also required canonical key order and rejected
 * negative numbers.
 *
 * And nothing bounded the coordinate. A hallucinated `{"x":99999}` was
 * converted and clicked.
 *
 * On bbox: it is carried for verification, cropping, and size sanity — NOT as
 * an accuracy mechanism. A controlled comparison (GUI-Actor, same training
 * recipe) scores bbox output below point output, so asking a model for a box
 * does not make its answer better. The box earns its place by letting us
 * reconcile against element geometry and re-crop for a second look.
 */

export type Point = { x: number; y: number };
export type BBox = { x: number; y: number; width: number; height: number };
export type Viewport = { width: number; height: number };

export type CandidateKind = 'grounding_bbox' | 'coordinate' | 'not_found';

export type GroundingCandidate = {
    schemaVersion: 'grounding-candidate-v1';
    found: boolean;
    kind: CandidateKind;
    bbox: BBox | null;
    point: Point;
    /** 0..1. Not comparable across providers; use it for gating, not for ranking. */
    confidence: number;
    description?: string;
    reason?: string;
    /** Machine-readable caveats, e.g. `point_only`, `out_of_bounds`. */
    riskFlags: string[];
};

/** Below this, a candidate must be verified before it is acted on. */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

/** A point-only answer carries no extent, so it starts as a coin flip. */
const POINT_ONLY_CONFIDENCE = 0.5;
const BBOX_CONFIDENCE = 0.8;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizePoint(value: unknown): Point | null {
    if (!isRecord(value)) return null;
    const x = finiteNumber(value['x']);
    const y = finiteNumber(value['y']);
    return x === null || y === null ? null : { x, y };
}

function normalizeBBox(value: unknown): BBox | null {
    if (!isRecord(value)) return null;
    const x = finiteNumber(value['x']);
    const y = finiteNumber(value['y']);
    const width = finiteNumber(value['width']);
    const height = finiteNumber(value['height']);
    if (x === null || y === null || width === null || height === null) return null;
    // A zero-area box carries no extent, which is the only thing a box is for.
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
}

function centerOfBBox(bbox: BBox): Point {
    return { x: Math.round(bbox.x + bbox.width / 2), y: Math.round(bbox.y + bbox.height / 2) };
}

function clampConfidence(value: unknown, fallback: number): number {
    const n = finiteNumber(value);
    return n === null ? fallback : Math.max(0, Math.min(1, n));
}

/**
 * Accepts the current shape and the legacy `{found,x,y}` one.
 *
 * A legacy answer is normalized rather than rejected, but it is marked:
 * `kind: 'coordinate'`, `point_only` in riskFlags, and a confidence that fails
 * the gate. It says where to click without saying how big the thing is, and
 * that difference should survive into the decision.
 */
export function normalizeCandidate(raw: unknown): GroundingCandidate | null {
    if (!isRecord(raw)) return null;
    if (typeof raw['found'] !== 'boolean') return null;

    if (!raw['found']) {
        return {
            schemaVersion: 'grounding-candidate-v1',
            found: false,
            kind: 'not_found',
            bbox: null,
            point: { x: 0, y: 0 },
            confidence: 0,
            description: typeof raw['description'] === 'string' ? raw['description'] : 'not found',
            reason: typeof raw['reason'] === 'string' ? raw['reason'] : 'target_not_found',
            riskFlags: [],
        };
    }

    const bbox = normalizeBBox(raw['bbox']);
    const explicitPoint = normalizePoint(raw['point']);
    const legacyPoint = normalizePoint(raw); // top-level {x, y}
    const point = explicitPoint ?? legacyPoint ?? (bbox ? centerOfBBox(bbox) : null);
    if (!point) return null;

    const pointOnly = !bbox;
    const candidate: GroundingCandidate = {
        schemaVersion: 'grounding-candidate-v1',
        found: true,
        kind: bbox ? 'grounding_bbox' : 'coordinate',
        bbox,
        point,
        confidence: clampConfidence(raw['confidence'], pointOnly ? POINT_ONLY_CONFIDENCE : BBOX_CONFIDENCE),
        riskFlags: pointOnly ? ['point_only'] : [],
    };
    if (typeof raw['description'] === 'string') candidate.description = raw['description'];
    if (typeof raw['reason'] === 'string') candidate.reason = raw['reason'];
    return candidate;
}

/**
 * Scan out balanced top-level JSON objects, tracking string state and escapes
 * so a brace inside a string literal does not open or close a span.
 *
 * This replaces a regex that could not represent nesting at all.
 */
export function extractJsonObjects(text: string): string[] {
    const objects: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (inString && ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            if (depth === 0) continue; // stray closer
            depth -= 1;
            if (depth === 0 && start !== -1) {
                objects.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return objects;
}

/**
 * Recover a candidate from arbitrary model text.
 *
 * Scans from the end: the answer is the last thing said, and earlier objects
 * are usually reasoning or echoed input.
 */
export function parseCandidate(text: string): GroundingCandidate | null {
    const objects = extractJsonObjects(text);
    for (let i = objects.length - 1; i >= 0; i--) {
        let parsed: unknown;
        try { parsed = JSON.parse(objects[i] as string); } catch { continue; }
        const candidate = normalizeCandidate(parsed);
        if (candidate) return candidate;
    }
    return null;
}

/**
 * Reject a point that cannot be on screen.
 *
 * The old path converted and clicked whatever came back, so a hallucinated
 * coordinate produced a click at an arbitrary place. Bounds are checked in the
 * candidate's own frame — image pixels when a clip was captured, otherwise the
 * viewport scaled by device pixel ratio.
 */
export function validateCandidate(
    candidate: GroundingCandidate,
    frame: { width: number; height: number },
): GroundingCandidate {
    if (!candidate.found) return candidate;
    const { x, y } = candidate.point;
    const inside = x >= 0 && y >= 0 && x <= frame.width && y <= frame.height;
    if (inside) return candidate;
    return {
        ...candidate,
        found: false,
        kind: 'not_found',
        confidence: 0,
        reason: `point (${x}, ${y}) is outside the ${frame.width}x${frame.height} capture`,
        riskFlags: [...candidate.riskFlags, 'out_of_bounds'],
    };
}

/** A candidate that must be verified before it is acted on. */
export function isLowConfidence(
    candidate: GroundingCandidate,
    threshold = LOW_CONFIDENCE_THRESHOLD,
): boolean {
    return candidate.confidence < threshold || candidate.riskFlags.includes('point_only');
}

