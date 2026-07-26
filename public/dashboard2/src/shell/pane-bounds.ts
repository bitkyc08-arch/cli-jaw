// CF-4 — one bounds helper for the side pane's state, CSS variable, pointer
// drag, and ARIA attributes. Without a single source of truth the initial
// PANE_DEFAULT can exceed the max on a narrow workbench and the drag clamp
// can dip below the min when the max itself is smaller, producing
// aria-valuenow outside [aria-valuemin, aria-valuemax]. Extracted so the
// math is unit-testable without a DOM.

export const PANE_MIN = 280;
export const CHAT_MIN = 280;
export const DIVIDER_WIDTH = 1;
export const PANE_DEFAULT = 340;

export interface PaneBounds {
    min: number;
    max: number;
}

/**
 * The max is the workbench width minus the chat's minimum and the divider,
 * but never below the min (a degenerate narrow workbench clamps to min).
 * A null width (unmeasured) falls back to a conservative default.
 */
export function paneBounds(workbenchWidth: number | null): PaneBounds {
    const max = workbenchWidth !== null
        ? Math.max(PANE_MIN, workbenchWidth - CHAT_MIN - DIVIDER_WIDTH)
        : 600;
    return { min: PANE_MIN, max };
}

export function clampPaneWidth(bounds: PaneBounds, value: number): number {
    return Math.max(bounds.min, Math.min(bounds.max, value));
}
