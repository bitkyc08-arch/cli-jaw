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
        const toolContentSize = last.toolContent?.reduce((total, content) => total + JSON.stringify(content).length, 0) ?? 0;
        return `${messages.length}:${last.role}:${last.text.length}:${last.toolOutput?.length ?? 0}:${toolContentSize}:${last.toolStatus ?? ''}`;
    }, [messages]);

    const scrollTranscriptToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        window.requestAnimationFrame(() => {
            const node = transcriptRef.current;
            if (!node) return;
            node.scrollTo({ top: node.scrollHeight, behavior });
            window.setTimeout(() => {
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
