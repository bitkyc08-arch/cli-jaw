// 044/086 — virtualized committed turn stream with stable scroll.
// Uses TanStack Virtual's built-in anchorTo:'end' + followOnAppend for
// chat-style bottom-anchored scrolling. NO custom scrollTop manipulation —
// the virtualizer owns scroll position entirely.
import { useCallback, useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TurnStore } from '../store/turn-store.ts';
import { useTurnList } from '../store/use-turn.ts';
import { LegacyMessageRow } from './LegacyMessageRow.tsx';
import { TurnRow } from './TurnRow.tsx';
import { LiveTailFollower } from './live-tail-follower.ts';
import { getRenderCache, heightCacheKey } from '../render/render-cache.ts';

const OVERSCAN = 4;

export interface TurnStreamViewportProps {
    store: TurnStore;
    head?: ReactNode;
    tail?: ReactNode;
}

export function TurnStreamViewport({ store, head, tail }: TurnStreamViewportProps): JSX.Element {
    const list = useTurnList(store);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const tailRef = useRef<HTMLDivElement | null>(null);
    const didInitialScroll = useRef(false);
    const pendingHeights = useRef(new Map<string, number>());
    const heightFlushFrame = useRef<number | null>(null);
    const cache = getRenderCache();
    cache.setScope(store.getScopeKey());

    const cacheKeyFor = (turnId: string, widthPx: number, expansionFingerprint = 'collapsed'): string | null => {
        const stub = store.getTurnSnapshot(turnId);
        if (!stub) return null;
        return heightCacheKey({
            threadId: store.getScopeKey(),
            turnId,
            contentRevision: stub.version,
            widthPx,
            fontMetricsVersion: 'dashboard2-v1',
            fontScale: 1,
            expansionFingerprint,
        });
    };

    const virtualizer = useVirtualizer({
        count: list.order.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) => {
            const key = list.order[index];
            if (key.startsWith('msg:')) return 56;
            const turnId = key.startsWith('turn:') ? key.slice(5) : key;
            const cacheKey = cacheKeyFor(turnId, scrollRef.current?.clientWidth ?? 0);
            const seeded = cacheKey ? cache.get('height', cacheKey) : undefined;
            return typeof seeded === 'number'
                ? seeded
                : store.getTurnSnapshot(turnId)?.heightEstimate ?? 72;
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

    const measureAndPersist = useCallback((node: HTMLDivElement | null): void => {
        virtualizer.measureElement(node);
        if (!node) return;
        const index = Number(node.dataset['index']);
        const listKey = list.order[index];
        if (!listKey || listKey.startsWith('msg:')) return;
        const turnId = listKey.startsWith('turn:') ? listKey.slice(5) : listKey;
        const expansionFingerprint = node.querySelector('[aria-expanded="true"]') ? 'expanded' : 'collapsed';
        const cacheKey = cacheKeyFor(turnId, scrollRef.current?.clientWidth ?? node.clientWidth, expansionFingerprint);
        if (!cacheKey) return;
        pendingHeights.current.set(cacheKey, node.getBoundingClientRect().height);
        if (heightFlushFrame.current !== null) return;
        heightFlushFrame.current = requestAnimationFrame(() => {
            heightFlushFrame.current = null;
            for (const [key, height] of pendingHeights.current) cache.set('height', key, height);
            pendingHeights.current.clear();
        });
    }, [cache, list.order, store, virtualizer]);

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

    // CF-1 — the live tail grows OUTSIDE the virtualizer, so followOnAppend
    // only follows committed-list appends, not the tail's height growth. A
    // user pinned at the bottom falls behind during streaming. Observe the
    // tail's height and re-follow only if the scrollport was already at the
    // bottom before the resize (a user reading upward is not yanked back).
    useEffect(() => {
        const scroll = scrollRef.current;
        const tailHost = tailRef.current;
        if (!scroll || !tailHost) return undefined;
        const follower = new LiveTailFollower(
            tailHost.getBoundingClientRect().height,
            () => {
                scroll.scrollTop = scroll.scrollHeight;
            },
        );
        const onScroll = (): void => {
            follower.recordScroll({
                scrollHeight: scroll.scrollHeight,
                scrollTop: scroll.scrollTop,
                clientHeight: scroll.clientHeight,
            });
        };
        scroll.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        const observer = new ResizeObserver(() => {
            follower.recordTailResize(tailHost.getBoundingClientRect().height);
        });
        observer.observe(tailHost);
        return () => {
            observer.disconnect();
            scroll.removeEventListener('scroll', onScroll);
        };
    }, [tail]);

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
                            ref={measureAndPersist}
                            style={{ transform: `translateY(${item.start}px)` }}
                        >
                            {content}
                        </div>
                    );
                })}
            </div>
            {tail ? (
                <div ref={tailRef} className="d2-turn-tail-host">
                    {tail}
                </div>
            ) : null}
        </div>
    );
}
