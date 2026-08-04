import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TranscriptEntry } from './code-types';

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
}

export function useCodeTranscriptScroll(messages: TranscriptEntry[], sending: boolean, activePopup: boolean) {
    const transcriptRef = useRef<HTMLDivElement>(null);
    const latestTranscriptFootprint = useMemo(() => {
        const last = messages[messages.length - 1];
        if (!last) return 'empty';
        // D5: this used to JSON.stringify the whole toolContent on every
        // `messages` identity change — i.e. every streaming token — which
        // serializes hundreds of KB just to build a change-detection string.
        // Length fields discriminate the same transitions at O(items) cost.
        const toolContentSize = last.toolContent?.reduce((total, content) => {
            const c = content as { text?: string; diff?: string; output?: string };
            return total + (c.text?.length ?? 0) + (c.diff?.length ?? 0) + (c.output?.length ?? 0);
        }, 0) ?? 0;
        return `${messages.length}:${last.role}:${last.text.length}:${last.toolOutput?.length ?? 0}:${toolContentSize}:${last.toolStatus ?? ''}`;
    }, [messages]);

    // D4: coalesce every scroll request onto a single in-flight frame. The old
    // shape queued a rAF *plus* a nested 80ms timeout per call, and callers fire
    // per SSE event, so ~40 tok/s produced ~120 layout-forcing callbacks per
    // second with two smooth-scroll animations fighting each other.
    const pendingFrameRef = useRef<number | null>(null);
    const settleTimerRef = useRef<number | null>(null);

    useEffect(() => () => {
        if (pendingFrameRef.current !== null) cancelAnimationFrame(pendingFrameRef.current);
        if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    }, []);

    const scrollTranscriptToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        if (pendingFrameRef.current !== null) return;
        pendingFrameRef.current = window.requestAnimationFrame(() => {
            pendingFrameRef.current = null;
            const node = transcriptRef.current;
            if (!node) return;
            node.scrollTo({ top: node.scrollHeight, behavior });
            // One trailing correction, not one per call: content that lands
            // after this frame still needs a final snap.
            if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
            settleTimerRef.current = window.setTimeout(() => {
                settleTimerRef.current = null;
                const latest = transcriptRef.current;
                if (!latest) return;
                latest.scrollTo({ top: latest.scrollHeight, behavior: 'auto' });
            }, 80);
        });
    }, []);

    const scrollTranscriptBy = useCallback((top: number, behavior: ScrollBehavior = 'smooth') => {
        window.requestAnimationFrame(() => {
            const node = transcriptRef.current;
            if (!node) return;
            node.scrollBy({ top, behavior });
        });
    }, []);

    const scrollTranscriptToTop = useCallback((behavior: ScrollBehavior = 'smooth') => {
        window.requestAnimationFrame(() => {
            const node = transcriptRef.current;
            if (!node) return;
            node.scrollTo({ top: 0, behavior });
        });
    }, []);

    useEffect(() => {
        scrollTranscriptToBottom(messages.length > 1 ? 'smooth' : 'auto');
    }, [latestTranscriptFootprint, messages.length, sending, scrollTranscriptToBottom]);

    useEffect(() => {
        const onWorkbenchKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || activePopup || event.metaKey || event.ctrlKey || event.altKey) return;
            if (isEditableKeyboardTarget(event.target)) return;
            const node = transcriptRef.current;
            if (!node) return;
            const key = event.key.toLowerCase();
            const page = Math.max(160, Math.floor(node.clientHeight * 0.78));
            if (key === 'd' || key === 'j' || event.key === 'PageDown') {
                event.preventDefault();
                scrollTranscriptBy(page);
            } else if (key === 'u' || key === 'k' || event.key === 'PageUp') {
                event.preventDefault();
                scrollTranscriptBy(-page);
            } else if (event.key === 'End') {
                event.preventDefault();
                scrollTranscriptToBottom('smooth');
            } else if (event.key === 'Home') {
                event.preventDefault();
                scrollTranscriptToTop('smooth');
            }
        };
        window.addEventListener('keydown', onWorkbenchKeyDown);
        return () => window.removeEventListener('keydown', onWorkbenchKeyDown);
    }, [activePopup, scrollTranscriptBy, scrollTranscriptToBottom, scrollTranscriptToTop]);

    return { transcriptRef, scrollTranscriptToBottom };
}
