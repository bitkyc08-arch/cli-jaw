// ── Streaming rAF Renderer ──
// Throttled markdown rendering during agent streaming.
// Prevents flicker by batching renders to 1 per animation frame.
// Array buffer avoids O(n) string copy per chunk.

import { renderMarkdown } from './render.js';

export interface StreamState {
    chunks: string[];
    fullText: string;
    textDirty: boolean;
    element: HTMLElement;
    pendingRAF: number | null;
    isFinalized: boolean;
    lastRenderTime: number;
}

const FULL_RENDER_THRESHOLD = 2000;
const THROTTLE_MS = 80;  // ~12fps — was 32ms (30fps), reduced to avoid blocking input

// Adaptive throttle (devlog 260705_frontend_perf H4): each live render re-parses
// the FULL accumulated text (marked + sanitize), so per-render cost grows with
// message length. Stretch the interval as the text grows to keep total work
// near-linear: 80ms under 2k chars, up to 400ms past ~50k chars.
const THROTTLE_MAX_MS = 400;
function throttleMsFor(textLength: number): number {
    if (textLength <= FULL_RENDER_THRESHOLD) return THROTTLE_MS;
    const scaled = THROTTLE_MS * (textLength / FULL_RENDER_THRESHOLD);
    return Math.min(THROTTLE_MAX_MS, Math.round(scaled));
}

export function createStreamRenderer(el: HTMLElement): StreamState {
    return {
        chunks: [], fullText: '', textDirty: false,
        element: el, pendingRAF: null, isFinalized: false, lastRenderTime: 0,
    };
}

export function hydrateStreamRenderer(el: HTMLElement, text = ''): StreamState {
    const ss = createStreamRenderer(el);
    if (text) {
        ss.chunks = [text];
        ss.fullText = text;
        ss.textDirty = false;
        ss.element.innerHTML = renderMarkdown(text, true) +
            '<span class="stream-cursor" aria-hidden="true"></span>';
    } else {
        ss.element.innerHTML = '<span class="stream-cursor" aria-hidden="true"></span>';
    }
    return ss;
}

function getFullText(ss: StreamState): string {
    if (ss.textDirty) {
        ss.fullText = ss.chunks.join('');
        ss.textDirty = false;
    }
    return ss.fullText;
}

export function appendChunk(ss: StreamState, chunk: string): void {
    ss.chunks.push(chunk);
    ss.textDirty = true;

    if (!ss.pendingRAF && !ss.isFinalized) {
        ss.pendingRAF = requestAnimationFrame(() => {
            ss.pendingRAF = null;
            if (ss.isFinalized) return;
            const now = performance.now();
            const text = getFullText(ss);
            if (text.length < FULL_RENDER_THRESHOLD || now - ss.lastRenderTime > throttleMsFor(text.length)) {
                ss.element.innerHTML = renderMarkdown(text, true) +
                    '<span class="stream-cursor" aria-hidden="true"></span>';
                ss.lastRenderTime = now;
            } else {
                ss.pendingRAF = requestAnimationFrame(() => {
                    ss.pendingRAF = null;
                    if (ss.isFinalized) return;
                    ss.element.innerHTML = renderMarkdown(getFullText(ss), true) +
                        '<span class="stream-cursor" aria-hidden="true"></span>';
                    ss.lastRenderTime = performance.now();
                });
            }
        });
    }
}

/**
 * Finalize streaming session. Returns accumulated text.
 * @param skipRender true when caller (finalizeAgent) will do its own full render.
 */
export function finalizeStream(ss: StreamState, skipRender = false): string {
    ss.isFinalized = true;
    if (ss.pendingRAF) {
        cancelAnimationFrame(ss.pendingRAF);
        ss.pendingRAF = null;
    }
    const text = getFullText(ss);
    if (!skipRender) {
        ss.element.innerHTML = renderMarkdown(text);
    }
    return text;
}
