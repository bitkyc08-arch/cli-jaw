// 044/086 — virtualized committed turn stream with stable scroll.
// Uses TanStack Virtual's built-in anchorTo:'end' + followOnAppend for
// chat-style bottom-anchored scrolling. NO custom scrollTop manipulation —
// the virtualizer owns scroll position entirely.
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TurnStore } from '../store/turn-store.ts';
import { useTurnList } from '../store/use-turn.ts';
import { LegacyMessageRow } from './LegacyMessageRow.tsx';
import { TurnRow } from './TurnRow.tsx';

const OVERSCAN = 4;

export interface TurnStreamViewportProps {
    store: TurnStore;
    head?: ReactNode;
    tail?: ReactNode;
}

export function TurnStreamViewport({ store, head, tail }: TurnStreamViewportProps): JSX.Element {
    const list = useTurnList(store);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const didInitialScroll = useRef(false);

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
        // 086 — virtualizer-native chat scroll:
        // anchorTo:'end' anchors from the bottom, so measurement corrections
        // don't shift the visible content. followOnAppend auto-scrolls to end
        // when new items arrive while already at the bottom.
        anchorTo: 'end',
        followOnAppend: 'smooth',
    });

    const totalSize = virtualizer.getTotalSize();

    // Scroll to bottom on initial load (once items are present)
    useEffect(() => {
        if (didInitialScroll.current || list.order.length === 0) return;
        didInitialScroll.current = true;
        // Give the virtualizer one frame to measure, then scroll to end
        requestAnimationFrame(() => {
            virtualizer.scrollToEnd();
        });
    }, [list.order.length, virtualizer]);

    // Reset initial-scroll flag on session/scope change
    useEffect(() => {
        didInitialScroll.current = false;
    }, [store]);

    return (
        <div
            ref={scrollRef}
            className="d2-turn-scroll"
            data-testid="turn-stream-viewport"
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
