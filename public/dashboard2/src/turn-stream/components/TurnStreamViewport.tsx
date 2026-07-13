// 044 — virtualized committed turn stream (M3.3 visual core).
// D12: @tanstack/react-virtual. Rows subscribe per-turn via useTurn; this
// viewport only consumes the list snapshot (order + versions).
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TurnStore } from '../store/turn-store.ts';
import { useTurnList } from '../store/use-turn.ts';
import { LegacyMessageRow } from './LegacyMessageRow.tsx';
import { TurnRow } from './TurnRow.tsx';

// D13 calibration (044 browser gate): the real TurnRow tree carries icon svgs
// and segment lines, so overscan 8 blew the 2,000-node budget (4,078 nodes at
// 1440x900). Overscan 4 keeps scroll headroom within budget.
const OVERSCAN = 4;
const BOTTOM_LOCK_SLACK_PX = 48;

export interface TurnStreamViewportProps {
    store: TurnStore;
    /** history load boundary rendered inside the scroll container, BEFORE the
     *  committed transcript (048 top sentinel) */
    head?: ReactNode;
    /** live tail region rendered inside the same scroll container, after the
     *  committed transcript (045); bottom lock covers auto-follow */
    tail?: ReactNode;
}

export function TurnStreamViewport({ store, head, tail }: TurnStreamViewportProps): JSX.Element {
    const list = useTurnList(store);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // Was the user at the bottom before the last list change?
    const wasAtBottomRef = useRef(true);
    // Suppress user-scroll capture during programmatic scrolls
    const programmaticScrollRef = useRef(false);

    const virtualizer = useVirtualizer({
        count: list.order.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) => {
            const key = list.order[index];
            if (key.startsWith('msg:')) return 56;
            return store.getTurnSnapshot(key.slice(5))?.heightEstimate ?? 72;
        },
        overscan: OVERSCAN,
        getItemKey: (index) => list.order[index],
    });

    const totalSize = virtualizer.getTotalSize();

    // Track whether user is at the bottom via scroll events (not layout effects)
    const onScroll = (): void => {
        if (programmaticScrollRef.current) return;
        const el = scrollRef.current;
        if (!el) return;
        wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_LOCK_SLACK_PX;
    };

    // Bottom-lock: when the LIST changes (new items) and user was at bottom, scroll down.
    // This fires only on list.version changes, NOT on measurement-driven totalSize changes.
    useEffect(() => {
        if (!wasAtBottomRef.current) return;
        const el = scrollRef.current;
        if (!el) return;
        // Use rAF to wait for the DOM to settle after the virtualizer re-renders
        const raf = requestAnimationFrame(() => {
            programmaticScrollRef.current = true;
            el.scrollTop = el.scrollHeight;
            // Reset after the browser processes the scroll
            requestAnimationFrame(() => { programmaticScrollRef.current = false; });
        });
        return () => cancelAnimationFrame(raf);
    }, [list.version]);

    return (
        <div
            ref={scrollRef}
            className="d2-turn-scroll"
            data-testid="turn-stream-viewport"
            onScroll={onScroll}
            style={{ overflowAnchor: 'none' }}
        >
            {head}
            <div
                className="d2-turn-transcript"
                data-testid="turn-stream-transcript"
                style={{ height: `${totalSize}px` }}
            >
                {virtualizer.getVirtualItems().map(item => {
                    const key = list.order[item.index];
                    let content: JSX.Element | null;
                    if (key.startsWith('msg:')) {
                        const legacy = store.getLegacyMessage(Number(key.slice(4)));
                        content = legacy ? <LegacyMessageRow message={legacy} /> : null;
                    } else {
                        content = <TurnRow store={store} turnId={key.startsWith('turn:') ? key.slice(5) : key} />;
                    }
                    return (
                        <div
                            key={item.key}
                            className="d2-turn-slot"
                            data-index={item.index}
                            ref={virtualizer.measureElement}
                            style={{ transform: `translateY(${item.start}px)` }}
                        >
                            {content}
                        </div>
                    );
                })}
            </div>
            {tail}
        </div>
    );
}
