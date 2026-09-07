import { useEffect, useRef, useState } from 'react';

const FULL_RENDER_THRESHOLD = 2000;
const THROTTLE_MS = 80;
const THROTTLE_MAX_MS = 400;
export function throttleMsFor(textLength: number): number {
    return textLength <= FULL_RENDER_THRESHOLD ? THROTTLE_MS
        : Math.min(THROTTLE_MAX_MS, Math.round(THROTTLE_MS * textLength / FULL_RENDER_THRESHOLD));
}

/** Throttle rendering only. Canonical final/identity changes bypass the timer. */
export function useThrottledMarkdown(text: string, final = false, identity = ''): string {
    const [visible, setVisible] = useState({ text, identity });
    const lastEmit = useRef(0);
    const immediate = final || visible.identity !== identity || !text.startsWith(visible.text);
    useEffect(() => {
        if (visible.text === text && visible.identity === identity) return;
        const publish = () => { lastEmit.current = Date.now(); setVisible({ text, identity }); };
        const remaining = throttleMsFor(text.length) - (Date.now() - lastEmit.current);
        if (immediate || remaining <= 0) { publish(); return; }
        const timer = window.setTimeout(publish, remaining);
        return () => window.clearTimeout(timer);
    }, [text, identity, immediate, visible]);
    return immediate ? text : visible.text;
}
