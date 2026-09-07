import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CodeItem } from '../../../../src/code-mode/wire';
import type { CodeTranscriptVirtualRows } from './useCodeTranscriptVirtualRows';

type Anchor = { itemId: string | null; offset: number; following: boolean };
const MAX_SCROLL_ANCHORS = 64;
const BOTTOM_SLOP = 64;
export function useCodeTranscriptScroll({ items, sessionKey, transcriptRef, virtual }: {
    items: CodeItem[]; sessionKey: string; transcriptRef: RefObject<HTMLDivElement | null>; virtual: CodeTranscriptVirtualRows;
}) {
    const anchors = useRef(new Map<string, Anchor>());
    const following = useRef(true);
    const [showJump, setShowJump] = useState(false);
    const previous = useRef({ sessionKey: '', firstId: '' });
    const state = useRef({ items, virtual, sessionKey });
    state.current = { items, virtual, sessionKey };
    const jumpToLatest = useCallback(() => {
        following.current = true; setShowJump(false);
        const node = transcriptRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [transcriptRef]);
    useLayoutEffect(() => {
        const node = transcriptRef.current;
        if (!node) return;
        const save = () => {
            const current = state.current;
            const row = current.virtual.virtualItems.find(item => item.end > node.scrollTop);
            const anchor = { itemId: row ? current.items[row.index]?.itemId ?? null : null,
                offset: row ? node.scrollTop - row.start : 0, following: following.current };
            anchors.current.delete(current.sessionKey);
            anchors.current.set(current.sessionKey, anchor);
            if (anchors.current.size > MAX_SCROLL_ANCHORS) {
                const oldest = anchors.current.keys().next().value;
                if (oldest !== undefined) anchors.current.delete(oldest);
            }
        };
        const onScroll = () => {
            if (!state.current.items.length) return;
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLOP;
            setShowJump(!following.current); save();
        };
        node.addEventListener('scroll', onScroll, { passive: true });
        return () => node.removeEventListener('scroll', onScroll);
    }, [transcriptRef]);
    useLayoutEffect(() => {
        const node = transcriptRef.current;
        if (!node) return;
        const firstId = items[0]?.itemId ?? '';
        const switched = previous.current.sessionKey !== sessionKey;
        const prepended = !switched && previous.current.firstId !== firstId;
        previous.current = { sessionKey, firstId };
        const saved = anchors.current.get(sessionKey);
        if (switched) {
            following.current = saved?.following ?? true;
            setShowJump(!following.current);
        }
        if (following.current) { node.scrollTop = node.scrollHeight; return; }
        if ((switched || prepended) && saved?.itemId) {
            const index = items.findIndex(item => item.itemId === saved.itemId);
            if (index >= 0) virtual.restoreAnchor(index, saved.offset);
        }
    }, [items, sessionKey, transcriptRef, virtual.totalSize]);
    return { showJump, jumpToLatest };
}
