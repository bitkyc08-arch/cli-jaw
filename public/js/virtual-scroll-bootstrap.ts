/**
 * Pure-logic bootstrap orchestrator for virtual scroll.
 * No DOM imports — safe to import in Node test environment.
 */
import type { VirtualItem, LazyRenderCallback } from './virtual-scroll.js';

export const BOOTSTRAP_SEED_COUNT = 20;

export interface VirtualHistoryBootstrapDeps {
    registerCallbacks: () => void;
    measureTailWindow: (items: VirtualItem[], seedCount: number) => number[];
    setItems: (items: VirtualItem[], options?: { autoActivate?: boolean; toBottom?: boolean }) => void;
    seedMeasuredHeights: (startIndex: number, heights: number[]) => void;
    activateIfNeeded: (toBottom: boolean) => void;
    scrollToBottom: () => void;
}

/**
 * Orchestrates virtual scroll bootstrap in correct order:
 * 1. registerCallbacks (onLazyRender, onPostRender)
 * 2. setItems with autoActivate:false (load all items without triggering activate)
 * 3. measureTailWindow (measure last N items for accurate initial heights)
 * 4. seedMeasuredHeights (feed measured heights back)
 * 5. activateIfNeeded (switch to VS mode with accurate bottom heights)
 * 6. scrollToBottom
 */
export function bootstrapVirtualHistory(
    items: VirtualItem[],
    deps: VirtualHistoryBootstrapDeps,
): void {
    deps.registerCallbacks();
    deps.setItems(items, { autoActivate: false });

    const seedStart = Math.max(0, items.length - BOOTSTRAP_SEED_COUNT);
    const heights = deps.measureTailWindow(items, BOOTSTRAP_SEED_COUNT);
    if (heights.length > 0) {
        deps.seedMeasuredHeights(seedStart, heights);
    }

    deps.activateIfNeeded(true);
    deps.scrollToBottom();
}
