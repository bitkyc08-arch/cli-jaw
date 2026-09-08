/**
 * src/browser/occlusion.ts — what will actually receive a click at a point.
 *
 * A coordinate click dispatches wherever the point lands. If a cookie banner,
 * modal or sticky header covers the target, that element receives the click
 * and the call still reports success — the most common silent failure in
 * coordinate-based automation, because nothing in the response says the wrong
 * thing was clicked.
 *
 * Ported from BrowserOS's hit test. Relatedness is decided IN THE PAGE against
 * the actual node, because that is the only place element identity is
 * knowable. An earlier version of this compared the reconciled ref's ARIA role
 * against the hit's DOM tag and blocked whenever they differed — a category
 * error that refused every `link` on an `a`, every `textbox` on an `input`,
 * and every `button` implemented as a `div`.
 *
 * The DOM half runs in the page. The decision rules are pure and live here so
 * they can be tested without a browser.
 */

export type HitResult = {
    /** A readable descriptor, e.g. `div#consent-banner`. */
    descriptor: string;
    /** Ancestor descriptors from the hit outward, nearest first. */
    ancestry: string[];
    /** True when the walk crossed into an iframe to reach the hit. */
    crossedFrame: boolean;
    /**
     * Whether the hit is the marked target, inside it, or contains it.
     * Undefined when no target was marked, which is not the same as false.
     */
    relatesToTarget?: boolean;
};

export type OcclusionVerdict =
    | { blocked: false; reason: 'clear' | 'unknown' }
    | { blocked: true; blocker: string; reason: string };

/**
 * Decide whether a hit means the click would go somewhere unintended.
 *
 * With no marked target — a pure coordinate click into canvas — there is
 * nothing to contradict, so the verdict is `unknown` rather than `clear`.
 * No evidence of a problem is not evidence of no problem, and collapsing the
 * two would let an unchecked click report as a verified one.
 */
export function judgeHit(hit: HitResult | null): OcclusionVerdict {
    // The hit test could not run — an unreadable cross-origin frame, a page
    // that navigated mid-check. Fail OPEN: an infrastructure failure must not
    // block a legitimate click, and pretending to know is worse than saying
    // we do not.
    if (!hit) return { blocked: false, reason: 'unknown' };

    if (hit.relatesToTarget === undefined) return { blocked: false, reason: 'unknown' };
    if (hit.relatesToTarget) return { blocked: false, reason: 'clear' };

    return {
        blocked: true,
        blocker: hit.descriptor,
        reason: hit.crossedFrame
            ? `the point resolves into an iframe, to ${hit.descriptor}, not the intended target`
            : `${hit.descriptor} covers the target at this point`,
    };
}

/**
 * The page-side hit test, as a function expression for `page.evaluate`.
 *
 * Takes the point and, optionally, a second point known to be on the intended
 * target — the centre of its reconciled box. The target node is resolved by
 * hit-testing THAT point, so identity comes from the DOM rather than from a
 * name we would have to invent. Descends nested iframes, subtracting each
 * frame's rect and border so the point stays in the child's coordinate space.
 */
export const HIT_TEST_SOURCE = `(arg) => {
    const describe = (el) => {
        if (!el || !el.tagName) return 'element';
        const tag = el.tagName.toLowerCase();
        if (el.id) return tag + '#' + el.id;
        if (typeof el.className === 'string' && el.className.trim()) {
            return tag + '.' + el.className.trim().split(/\\s+/)[0];
        }
        return tag;
    };
    const up = (node) => node
        ? (node.parentNode || node.host || (node.getRootNode && node.getRootNode().host) || null)
        : null;
    const reaches = (from, to) => {
        for (let node = from, guard = 0; node && guard < 200; node = up(node), guard++) {
            if (node === to) return true;
        }
        return false;
    };

    let target = null;
    if (arg.targetPoint) {
        target = document.elementFromPoint(arg.targetPoint.x, arg.targetPoint.y);
    }

    let doc = document;
    let x = arg.x;
    let y = arg.y;
    let crossedFrame = false;
    let hit = doc.elementFromPoint(x, y);

    // Bounded: a frame chain should be shallow, and a cycle must not hang the
    // page.
    for (let depth = 0; depth < 16; depth++) {
        if (!hit || (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME')) break;
        if (target && (hit === target || reaches(target, hit))) break;
        let childDoc = null;
        try { childDoc = hit.contentDocument; } catch (_) { childDoc = null; }
        if (!childDoc) break;
        const rect = hit.getBoundingClientRect();
        // elementFromPoint in the child is relative to the child's own
        // viewport, so subtract the frame's position and its border.
        x -= rect.left + hit.clientLeft;
        y -= rect.top + hit.clientTop;
        doc = childDoc;
        crossedFrame = true;
        const next = doc.elementFromPoint(x, y);
        if (!next) break;
        hit = next;
    }

    if (!hit) return null;

    const ancestry = [];
    for (let node = up(hit), guard = 0; node && guard < 24; node = up(node), guard++) {
        if (node.tagName) ancestry.push(describe(node));
    }

    const result = { descriptor: describe(hit), ancestry: ancestry, crossedFrame: crossedFrame };
    if (target) {
        // The hit is the target, inside it, or contains it. Clicking a
        // button's inner span is clicking the button. A label that forwards to
        // this control counts too.
        let related = hit === target || reaches(hit, target) || reaches(target, hit);
        if (!related && hit.closest) {
            const lbl = hit.closest('label');
            if (lbl && (lbl.control === target || lbl.contains(target))) related = true;
        }
        result.relatesToTarget = related;
    }
    return result;
}`;
