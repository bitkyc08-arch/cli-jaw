import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
    Virtualizer,
    elementScroll,
    measureElement,
    observeElementOffset,
    observeElementRect,
    type VirtualItem,
} from '@tanstack/virtual-core';

const ESTIMATED_TRANSCRIPT_ROW_HEIGHT = 92;
const OVERSCAN = 6;

type Snapshot = {
    virtualItems: VirtualItem[];
    totalSize: number;
};

export type CodeTranscriptVirtualRows = {
    measureElement: (element: HTMLDivElement | null) => void;
    virtualItems: VirtualItem[];
    totalSize: number;
};

export function useCodeTranscriptVirtualRows(args: {
    count: number;
    scrollElementRef: RefObject<HTMLDivElement | null>;
    getItemKey: (index: number) => string | number;
    estimateSize?: (index: number) => number;
}): CodeTranscriptVirtualRows {
    const [{ virtualItems, totalSize }, setSnapshot] = useState<Snapshot>({ virtualItems: [], totalSize: 0 });
    const virtualizerRef = useRef<Virtualizer<HTMLElement, HTMLElement> | null>(null);

    if (!virtualizerRef.current) {
        virtualizerRef.current = new Virtualizer<HTMLElement, HTMLElement>({
            count: args.count,
            getScrollElement: () => args.scrollElementRef.current,
            estimateSize: args.estimateSize || (() => ESTIMATED_TRANSCRIPT_ROW_HEIGHT),
            overscan: OVERSCAN,
            getItemKey: args.getItemKey,
            indexAttribute: 'data-code-transcript-idx',
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

    useEffect(() => virtualizer._didMount(), [virtualizer]);

    useLayoutEffect(() => {
        virtualizer.setOptions({
            ...virtualizer.options,
            count: args.count,
            getItemKey: args.getItemKey,
            estimateSize: args.estimateSize || (() => ESTIMATED_TRANSCRIPT_ROW_HEIGHT),
        });
        virtualizer._willUpdate();
        setSnapshot({
            virtualItems: virtualizer.getVirtualItems(),
            totalSize: virtualizer.getTotalSize(),
        });
    }, [args.count, args.estimateSize, args.getItemKey, virtualizer]);

    return {
        measureElement: element => {
            if (element) virtualizer.measureElement(element);
        },
        virtualItems,
        totalSize,
    };
}
