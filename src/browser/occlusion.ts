/**
 * src/browser/occlusion.ts — what will actually receive a click at a point.
 *
 * A coordinate click dispatches wherever the point lands. If a cookie banner,
 * modal or sticky header covers the target, that element receives the click
 * and the call still reports success — the single most common silent failure
 * in coordinate-based automation, because nothing in the response says the
 * wrong thing was clicked.
 *
 * Ported from BrowserOS's hit test, with one deliberate difference. BrowserOS
 * asks "is my resolved element covered at this point"; cli-jaw's coordinate
 * path has no element yet, so this asks "what is here, and does it belong to
 * something I expected". Both questions need the same DOM walk.
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
};

export type OcclusionVerdict =
    | { blocked: false; reason: 'clear' | 'unknown' }
    | { blocked: true; blocker: string; reason: string };

/**
 * Elements that legitimately sit over a target and still deliver the click.
 *
 * A label forwards to its control, and an overlay explicitly marked
 * non-interactive cannot receive the event at all. Treating these as blockers
 * would refuse clicks that would have worked.
 */
const TRANSPARENT_ROLES = new Set(['label', 'none', 'presentation']);

/**
 * Decide whether a hit means the click would go somewhere unintended.
 *
 * `expected` is the descriptor set the caller believes it is clicking — the
 * reconciled ref's own descriptor and its ancestry. When the caller has no
 * expectation (a pure coordinate click into canvas), there is nothing to
 * contradict, so the verdict is `unknown` rather than `clear`: no evidence of
 * a problem is not evidence of no problem.
 */
export function judgeHit(hit: HitResult | null, expected: string[] = []): OcclusionVerdict {
    // The hit test could not run — an unreadable cross-origin frame, a page
    // that navigated mid-check. Fail OPEN: an infrastructure failure must not
    // block a legitimate click, and pretending to know is worse than saying
    // we do not.
    if (!hit) return { blocked: false, reason: 'unknown' };

    if (expected.length === 0) return { blocked: false, reason: 'unknown' };

    // The hit is the expected element, or inside it, or an ancestor of it.
    // Clicking a button's inner span is clicking the button.
    const related = [hit.descriptor, ...hit.ancestry];
    if (related.some(d => expected.includes(d))) return { blocked: false, reason: 'clear' };
    if (expected.some(e => related.includes(e))) return { blocked: false, reason: 'clear' };

    // A label or a presentational wrapper forwards rather than intercepts.
    const tag = hit.descriptor.split(/[#.]/)[0] ?? '';
    if (TRANSPARENT_ROLES.has(tag)) return { blocked: false, reason: 'clear' };

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
 * Descends nested iframes, subtracting each frame's rect and border so the
 * point stays in the child's coordinate space, and reports ancestry so the
 * caller can tell a genuine cover from a click on a target's own child.
 */
export const HIT_TEST_SOURCE = `(point) => {
    const describe = (el) => {
        if (!el || !el.tagName) return 'element';
        let d = el.tagName.toLowerCase();
        if (el.id) return d + '#' + el.id;
        if (typeof el.className === 'string' && el.className.trim()) {
            return d + '.' + el.className.trim().split(/\\s+/)[0];
        }
        return d;
    };
    const up = (node) => node
        ? (node.parentNode || node.host || (node.getRootNode && node.getRootNode().host) || null)
        : null;

    let doc = document;
    let x = point.x;
    let y = point.y;
    let crossedFrame = false;
    let hit = doc.elementFromPoint(x, y);

    while (hit && (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME')) {
        let childDoc = null;
        try { childDoc = hit.contentDocument; } catch (_) { childDoc = null; }
        if (!childDoc) break;
        const rect = hit.getBoundingClientRect();
        x -= rect.x + hit.clientLeft;
        y -= rect.y + hit.clientTop;
        doc = childDoc;
        crossedFrame = true;
        const next = doc.elementFromPoint(x, y);
        if (!next) break;
        hit = next;
    }

    if (!hit) return null;

    const ancestry = [];
    for (let node = up(hit); node && ancestry.length < 24; node = up(node)) {
        if (node.tagName) ancestry.push(describe(node));
    }
    return { descriptor: describe(hit), ancestry: ancestry, crossedFrame: crossedFrame };
}`;

