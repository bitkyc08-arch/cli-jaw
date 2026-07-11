// 044 — virtualized committed turn stream (M3.3 visual core).
// D12: @tanstack/react-virtual. Rows subscribe per-turn via useTurn; this
// viewport only consumes the list snapshot (order + versions).
import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TurnStore } from '../store/turn-store.ts';
import { useTurnList } from '../store/use-turn.ts';
import { TurnRow } from './TurnRow.tsx';

// D13 calibration (044 browser gate): the real TurnRow tree carries icon svgs
// and segment lines, so overscan 8 blew the 2,000-node budget (4,078 nodes at
// 1440x900). Overscan 4 keeps scroll headroom within budget.
const OVERSCAN = 4;
const BOTTOM_LOCK_SLACK_PX = 48;

export interface TurnStreamViewportProps {
    store: TurnStore;
    /** live tail region rendered inside the same scroll container, after the
     *  committed transcript (045); bottom lock covers auto-follow */
    tail?: ReactNode;
}

export function TurnStreamViewport({ store, tail }: TurnStreamViewportProps): JSX.Element {
    const list = useTurnList(store);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const prevTotalRef = useRef(0);
    // anchor capture/restore (port of public/js/virtual-scroll.ts:337-351):
    // remember the first visible item + its visual offset per list version;
    // when the list changes (insertions above), restore its visual position.
    const anchorRef = useRef<{ key: string; visualOffset: number } | null>(null);
    // scroll events inside this window after a data commit are programmatic
    // (our restore, virtualizer adjustments) — they must not steal the anchor
    const commitTsRef = useRef(0);
    const SETTLE_WINDOW_MS = 150;

    const virtualizer = useVirtualizer({
        count: list.order.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) => store.getTurnSnapshot(list.order[index])?.heightEstimate ?? 72,
        overscan: OVERSCAN,
        getItemKey: (index) => list.order[index],
    });

    const totalSize = virtualizer.getTotalSize();

    // USER scrolling owns the position: every scroll event re-captures the
    // anchor so the layout-effect restore below becomes a no-op for scrolls
    // and only corrects data/measurement-driven shifts.
    const captureAnchor = () => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const first = virtualizer.getVirtualItems().find(item => item.end > scroller.scrollTop);
        anchorRef.current = first
            ? { key: String(first.key), visualOffset: first.start - scroller.scrollTop }
            : null;
    };

    const onUserScroll = () => {
        if (performance.now() - commitTsRef.current < SETTLE_WINDOW_MS) return;
        captureAnchor();
    };

    useLayoutEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) { prevTotalRef.current = totalSize; return; }
        const anchor = anchorRef.current;
        // bottom lock first: growth while pinned at the end keeps the end pinned
        const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        const atBottom = distance <= BOTTOM_LOCK_SLACK_PX;
        if (atBottom && totalSize > prevTotalRef.current) {
            scroller.scrollTop = scroller.scrollHeight;
        } else if (anchor) {
            // restore the anchor's visual offset against data/measurement
            // shifts (prepends, remeasures, native anchoring interference)
            const index = list.order.indexOf(anchor.key);
            if (index >= 0) {
                const offset = virtualizer.getOffsetForIndex(index, 'start');
                if (offset) {
                    const target = offset[0] - anchor.visualOffset;
                    if (Math.abs(target - scroller.scrollTop) > 0.5) scroller.scrollTop = target;
                }
            }
        }
        prevTotalRef.current = totalSize;
        commitTsRef.current = performance.now();
        if (!anchorRef.current) captureAnchor();
    });

    return (
        <div
            ref={scrollRef}
            className="d2-turn-scroll"
            data-testid="turn-stream-viewport"
            onScroll={onUserScroll}
            // manual anchor restore owns the position; native scroll anchoring
            // misfires on transform-positioned virtual rows
            style={{ overflowAnchor: 'none' }}
        >
            <div
                className="d2-turn-transcript"
                data-testid="turn-stream-transcript"
                style={{ height: `${totalSize}px` }}
            >
                {virtualizer.getVirtualItems().map(item => (
                    <div
                        key={item.key}
                        className="d2-turn-slot"
                        data-index={item.index}
                        ref={virtualizer.measureElement}
                        style={{ transform: `translateY(${item.start}px)` }}
                    >
                        <TurnRow store={store} turnId={list.order[item.index]} />
                    </div>
                ))}
            </div>
            {tail}
        </div>
    );
}
