// ── Streaming rAF Renderer ──
// Phase 3/8: throttled markdown rendering during agent streaming
// Prevents flicker by batching renders to 1 per animation frame.

import { renderMarkdown } from './render.js';

export interface StreamState {
    fullText: string;
    element: HTMLElement;
    pendingRAF: number | null;
    isFinalized: boolean;
    lastRenderTime: number;
}

const FULL_RENDER_THRESHOLD = 2000;
const THROTTLE_MS = 80;  // ~12fps — was 32ms (30fps), reduced to avoid blocking input

export function createStreamRenderer(el: HTMLElement): StreamState {
    return { fullText: '', element: el, pendingRAF: null, isFinalized: false, lastRenderTime: 0 };
}

export function appendChunk(ss: StreamState, chunk: string): void {
    ss.fullText += chunk;
    if (!ss.pendingRAF && !ss.isFinalized) {
        ss.pendingRAF = requestAnimationFrame(() => {
            ss.pendingRAF = null;
            if (ss.isFinalized) return;
            const now = performance.now();
            if (ss.fullText.length < FULL_RENDER_THRESHOLD || now - ss.lastRenderTime > THROTTLE_MS) {
                ss.element.innerHTML = renderMarkdown(ss.fullText, true) +
                    '<span class="stream-cursor" aria-hidden="true"></span>';
                ss.lastRenderTime = now;
            } else {
                // Throttled — schedule trailing render to ensure latest text paints
                ss.pendingRAF = requestAnimationFrame(() => {
                    ss.pendingRAF = null;
                    if (ss.isFinalized) return;
                    ss.element.innerHTML = renderMarkdown(ss.fullText, true) +
                        '<span class="stream-cursor" aria-hidden="true"></span>';
                    ss.lastRenderTime = performance.now();
                });
            }
        });
    }
}

export function finalizeStream(ss: StreamState): string {
    ss.isFinalized = true;
    if (ss.pendingRAF) {
        cancelAnimationFrame(ss.pendingRAF);
        ss.pendingRAF = null;
    }
    ss.element.innerHTML = renderMarkdown(ss.fullText);
    return ss.fullText;
}
