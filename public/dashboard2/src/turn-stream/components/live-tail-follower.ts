// CF-1 — the live tail grows OUTSIDE the virtualizer, so the virtualizer's
// followOnAppend only follows committed-list appends, not the tail's height
// growth. This follower decides, purely, when a tail resize should re-pin the
// scrollport to the end: only when the user was already at the bottom BEFORE
// the resize. Extracted so the decision is unit-testable without a DOM.

export interface ScrollportSnapshot {
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
}

export const AT_END_THRESHOLD_PX = 4;

export class LiveTailFollower {
    private pinned = true;
    private lastHeight: number;

    constructor(initialTailHeight: number, private readonly follow: () => void) {
        this.lastHeight = initialTailHeight;
    }

    /**
     * Record the pinned-at-end state from a scroll event. This must run on
     * scroll, not inside the resize observer: evaluated after the tail grew,
     * scrollHeight has already increased and the gap would always read "not
     * at end", so the follow would never fire.
     */
    recordScroll(snapshot: ScrollportSnapshot): void {
        const gap = snapshot.scrollHeight - snapshot.scrollTop - snapshot.clientHeight;
        this.pinned = gap <= AT_END_THRESHOLD_PX;
    }

    /** A tail resize re-follows only on a real height change while pinned. */
    recordTailResize(nextHeight: number): void {
        if (nextHeight !== this.lastHeight && this.pinned) this.follow();
        this.lastHeight = nextHeight;
    }
}
