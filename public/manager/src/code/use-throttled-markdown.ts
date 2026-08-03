import { useEffect, useRef, useState } from 'react';

/**
 * D1 (260803 unit, 020 phase) — adaptive streaming throttle.
 *
 * Rendering assistant markdown re-parses the FULL accumulated text on every
 * update (remark → rehype → sanitize → KaTeX), so per-render cost grows with
 * message length and a naive per-token render is O(L²) overall.
 *
 * The legacy UI reached this conclusion first; these constants are lifted
 * verbatim from public/js/streaming-render.ts:18-30 rather than re-derived,
 * so both renderers behave the same under load.
 */
const FULL_RENDER_THRESHOLD = 2000;
const THROTTLE_MS = 80;
const THROTTLE_MAX_MS = 400;

export function throttleMsFor(textLength: number): number {
    if (textLength <= FULL_RENDER_THRESHOLD) return THROTTLE_MS;
    const scaled = THROTTLE_MS * (textLength / FULL_RENDER_THRESHOLD);
    return Math.min(THROTTLE_MAX_MS, Math.round(scaled));
}

/**
 * Returns `text` throttled by the adaptive interval above. Growth is rate
 * limited; a shrink or replacement (new message, session switch) applies
 * immediately so the view never shows stale content from another turn.
 *
 * Always trailing-edge: the final value lands even if the last change arrives
 * inside a throttle window, so no explicit "turn done" signal is needed.
 */
export function useThrottledMarkdown(text: string): string {
    const [visible, setVisible] = useState(text);
    const lastEmitRef = useRef(0);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        // Only a pure append is streaming growth. A prefix-only check would
        // treat an in-place edit past the compared window as growth and hold
        // stale text for up to one interval; comparing the full visible string
        // is exact, and only runs on the fast path.
        const isAppend = text.length >= visible.length && text.startsWith(visible);
        if (!isAppend) {
            if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            lastEmitRef.current = Date.now();
            setVisible(text);
            return;
        }
        if (text === visible) return;

        const wait = throttleMsFor(text.length);
        const since = Date.now() - lastEmitRef.current;
        if (since >= wait) {
            lastEmitRef.current = Date.now();
            setVisible(text);
            return;
        }

        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            lastEmitRef.current = Date.now();
            setVisible(text);
        }, wait - since);
    }, [text, visible]);

    useEffect(() => () => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    }, []);

    return visible;
}
