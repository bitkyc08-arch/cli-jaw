import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    Virtualizer,
    elementScroll,
    measureElement,
    observeElementOffset,
    observeElementRect,
    type VirtualItem,
} from '@tanstack/virtual-core';

const ESTIMATED_ROW_HEIGHT = 76;
const OVERSCAN = 8;
const FOLLOW_BOTTOM_THRESHOLD_PX = 96;

type Snapshot = {
    virtualItems: VirtualItem[];
    totalSize: number;
};

export type JawCeoVirtualTimeline = {
    scrollRef: (element: HTMLDivElement | null) => void;
    onScroll: () => void;
    measureElement: (element: HTMLDivElement | null) => void;
    virtualItems: VirtualItem[];
    totalSize: number;
};

function isNearBottom(element: HTMLElement | null): boolean {
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_BOTTOM_THRESHOLD_PX;
}

export function useJawCeoVirtualTimeline(args: {
    count: number;
    getItemKey: (index: number) => string | number;
    estimateSize?: (index: number) => number;
}): JawCeoVirtualTimeline {
    const scrollElementRef = useRef<HTMLDivElement | null>(null);
    const followBottomRef = useRef(true);
    const previousCountRef = useRef(args.count);
    const [{ virtualItems, totalSize }, setSnapshot] = useState<Snapshot>({ virtualItems: [], totalSize: 0 });
    const virtualizerRef = useRef<Virtualizer<HTMLElement, HTMLElement> | null>(null);

    if (!virtualizerRef.current) {
        virtualizerRef.current = new Virtualizer<HTMLElement, HTMLElement>({
            count: args.count,
            getScrollElement: () => scrollElementRef.current,
            estimateSize: args.estimateSize || (() => ESTIMATED_ROW_HEIGHT),
            overscan: OVERSCAN,
            getItemKey: args.getItemKey,
            indexAttribute: 'data-jaw-ceo-idx',
            useAnimationFrameWithResizeObserver: true,
            observeElementRect,
            observeElementOffset,
            scrollToFn: elementScroll,
            measureElement,
            onChange: instance => {
                setSnapshot({
                    virtualItems: instance.getVirtualItems(),
                    totalSize: instance.getTotalSize(),
                });
            },
        });
    }

    const virtualizer = virtualizerRef.current;

    const scrollRef = useCallback((element: HTMLDivElement | null): void => {
        scrollElementRef.current = element;
        followBottomRef.current = isNearBottom(element);
        virtualizer._willUpdate();
    }, [virtualizer]);

    const onScroll = useCallback((): void => {
        followBottomRef.current = isNearBottom(scrollElementRef.current);
    }, []);

    const measureVirtualElement = useCallback((element: HTMLDivElement | null): void => {
        if (element) virtualizer.measureElement(element);
    }, [virtualizer]);

    useEffect(() => virtualizer._didMount(), [virtualizer]);

    // D2 sibling (050 phase): release the instance on unmount. The CEO console
    // has no per-session key to reset against — it renders one continuous
    // timeline — so only the retention half applies here.
    useEffect(() => () => { virtualizerRef.current = null; }, []);

    useLayoutEffect(() => {
        virtualizer.setOptions({
            ...virtualizer.options,
            count: args.count,
            getItemKey: args.getItemKey,
            estimateSize: args.estimateSize || (() => ESTIMATED_ROW_HEIGHT),
        });
        virtualizer._willUpdate();
        setSnapshot({
            virtualItems: virtualizer.getVirtualItems(),
            totalSize: virtualizer.getTotalSize(),
        });
    }, [args.count, args.estimateSize, args.getItemKey, virtualizer]);

    useLayoutEffect(() => {
        const previous = previousCountRef.current;
        previousCountRef.current = args.count;
        if (args.count === 0) return;
        if (previous > 0 && !followBottomRef.current) return;
        requestAnimationFrame(() => {
            virtualizer.scrollToIndex(args.count - 1, { align: 'end' });
        });
    }, [args.count, virtualizer]);

    return { scrollRef, onScroll, measureElement: measureVirtualElement, virtualItems, totalSize };
}
