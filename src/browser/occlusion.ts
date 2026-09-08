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
 * knowable: comparing a reconciled ref's ARIA role against a DOM tag name is a
 * category error, since a `link` is an `a`, a `textbox` is an `input`, and a
 * `button` is often a `div`.
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
    /**
     * True when the walk stopped at a frame it could not see into.
     *
     * The element behind a cross-origin frame is unknowable from here, so the
     * frame itself is reported as the hit — which looks exactly like a cover.
     * Callers must treat this as "unknown", not as a blocker: the target may
     * well be inside that frame.
     */
    opaqueFrame?: boolean;
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

    // The walk stopped at a frame it could not see into. Whatever is behind it
    // is unknowable, and a target inside that frame would look identical to a
    // cover. Refusing on that evidence would block legitimate clicks into
    // every cross-origin embed.
    if (hit.opaqueFrame) return { blocked: false, reason: 'unknown' };

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

export type HitTestArg = {
    x: number;
    y: number;
    /** A point known to be on the intended target, e.g. its box centre. */
    targetPoint?: { x: number; y: number };
};

/**
 * The page-side hit test. **A real function, deliberately not a source string.**
 *
 * Playwright sets `isFunction: typeof pageFunction === "function"`. Pass a
 * string and the page evaluates the expression, obtains a function object, and
 * never calls it — the result serializes to `undefined`. An earlier version of
 * this shipped as a string, which made the entire check a permanent no-op. It
 * was invisible precisely because the guard fails open: `undefined` became
 * `null` became "unknown", indistinguishable from the intended safe path.
 *
 * Everything below runs in the page, so it may only use DOM globals.
 */
export function hitTestInPage(arg: HitTestArg): HitResult | null {
    type El = {
        tagName?: string; id?: string; className?: unknown;
        parentNode?: El; host?: El; getRootNode?: () => { host?: El };
        contentDocument?: Document | null;
        getBoundingClientRect: () => { left: number; top: number };
        clientLeft: number; clientTop: number;
        closest?: (s: string) => (El & { control?: El; contains?: (n: El) => boolean }) | null;
        contains?: (n: El) => boolean;
    } | null;

    const describe = (el: El): string => {
        if (!el || !el.tagName) return 'element';
        const tag = String(el.tagName).toLowerCase();
        if (el.id) return tag + '#' + el.id;
        if (typeof el.className === 'string' && el.className.trim()) {
            return tag + '.' + el.className.trim().split(/\s+/)[0];
        }
        return tag;
    };
    const up = (node: El): El => {
        if (!node) return null;
        return node.parentNode || node.host || (node.getRootNode ? node.getRootNode().host ?? null : null) || null;
    };
    const reaches = (from: El, to: El): boolean => {
        for (let node = from, guard = 0; node && guard < 200; node = up(node), guard++) {
            if (node === to) return true;
        }
        return false;
    };

    let target: El = null;
    if (arg.targetPoint) {
        target = document.elementFromPoint(arg.targetPoint.x, arg.targetPoint.y) as unknown as El;
    }

    let doc: Document = document;
    let x = arg.x;
    let y = arg.y;
    let crossedFrame = false;
    let opaqueFrame = false;
    let hit: El = doc.elementFromPoint(x, y) as unknown as El;

    // Bounded: a frame chain should be shallow, and a cycle must not hang the page.
    for (let depth = 0; depth < 16; depth++) {
        if (!hit || (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME')) break;
        if (target && (hit === target || reaches(target, hit))) break;
        let childDoc: Document | null = null;
        try { childDoc = hit.contentDocument ?? null; } catch { childDoc = null; }
        if (!childDoc) { opaqueFrame = true; break; }
        const rect = hit.getBoundingClientRect();
        // elementFromPoint in the child is relative to the child's own
        // viewport, so subtract the frame's position and its border.
        x -= rect.left + hit.clientLeft;
        y -= rect.top + hit.clientTop;
        doc = childDoc;
        crossedFrame = true;
        const next = doc.elementFromPoint(x, y) as unknown as El;
        if (!next) break;
        hit = next;
    }

    if (!hit) return null;

    const ancestry: string[] = [];
    for (let node = up(hit), guard = 0; node && guard < 24; node = up(node), guard++) {
        if (node.tagName) ancestry.push(describe(node));
    }

    const result: HitResult = { descriptor: describe(hit), ancestry, crossedFrame };
    if (opaqueFrame) result.opaqueFrame = true;
    if (target) {
        // The hit is the target, inside it, or contains it. Clicking a
        // button's inner span is clicking the button. A label forwarding to
        // this control counts too.
        let related = hit === target || reaches(hit, target) || reaches(target, hit);
        if (!related && hit.closest) {
            const lbl = hit.closest('label');
            if (lbl && (lbl.control === target || (lbl.contains ? lbl.contains(target) : false))) related = true;
        }
        result.relatesToTarget = related;
    }
    return result;
}
