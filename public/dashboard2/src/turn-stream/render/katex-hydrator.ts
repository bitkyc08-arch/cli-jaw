import { renderCopy, type RenderLocale } from './copy-catalog.js';
import type { MarkdownSlot } from './markdown-slot-manifest.js';
import { contentHash, embedCacheKey, getRenderCache } from './render-cache.js';
import { sanitizeHtml, type SanitizedHtml } from './sanitize-policy.js';

const TEX_MAX = 32 * 1024;
export type MathHydrationResult =
    | { kind: 'ready'; html: SanitizedHtml }
    | { kind: 'error'; source: string; label: string }
    | { kind: 'oversize'; source: string; label: string; sizeKiB: number };
export interface KatexHydratorOptions {
    container: Element; scrollRoot: Element; slots: readonly Extract<MarkdownSlot, { kind: 'math' }>[];
    generation: number; currentGeneration(): number; locale: RenderLocale;
    onResult(slot: Extract<MarkdownSlot, { kind: 'math' }>, result: MathHydrationResult): void;
}
export interface KatexObserverOptions { scrollRoot: Element | null }

export async function renderMathSlot(slot: Extract<MarkdownSlot, { kind: 'math' }>, locale: RenderLocale): Promise<MathHydrationResult> {
    const size = new TextEncoder().encode(slot.tex).byteLength;
    if (size > TEX_MAX) return { kind: 'oversize', source: slot.tex, sizeKiB: Math.ceil(size / 1024), label: renderCopy(locale, 'math.oversize', { sizeKiB: Math.ceil(size / 1024) }) };
    const key = embedCacheKey(contentHash(slot.tex), slot.displayMode);
    const cached = getRenderCache().get('embed', key);
    if (typeof cached === 'string') return { kind: 'ready', html: cached as SanitizedHtml };
    try {
        const katex = await import('katex');
        const unsafe = katex.default.renderToString(slot.tex, { output: 'html', displayMode: slot.displayMode, throwOnError: false });
        if (/class="katex-error"/.test(unsafe)) return { kind: 'error', source: slot.tex, label: renderCopy(locale, 'math.error') };
        const html = sanitizeHtml(unsafe, 'katex'); getRenderCache().set('embed', key, html);
        return { kind: 'ready', html };
    } catch { return { kind: 'error', source: slot.tex, label: renderCopy(locale, 'math.error') }; }
}

export function createKatexHydrator(options: KatexHydratorOptions): { dispose(): void };
export function createKatexHydrator(options: KatexObserverOptions): { observe(element: Element, slot: Extract<MarkdownSlot, { kind: 'math' }>, onReady: (html: SanitizedHtml) => void): () => void };
export function createKatexHydrator(options: KatexHydratorOptions | KatexObserverOptions): { dispose(): void } | { observe(element: Element, slot: Extract<MarkdownSlot, { kind: 'math' }>, onReady: (html: SanitizedHtml) => void): () => void } {
    if (!('container' in options)) {
        return { observe(element, slot, onReady) {
            let disposed = false;
            const observer = new IntersectionObserver(entries => {
                if (!entries.some(entry => entry.isIntersecting)) return;
                observer.disconnect();
                void renderMathSlot(slot, 'en').then(result => { if (!disposed && result.kind === 'ready') onReady(result.html); });
            }, { root: options.scrollRoot, rootMargin: '600px 0px', threshold: 0 });
            observer.observe(element);
            return () => { disposed = true; observer.disconnect(); };
        } };
    }
    let disposed = false;
    const byElement = new Map<Element, Extract<MarkdownSlot, { kind: 'math' }>>();
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const slot = byElement.get(entry.target); if (!slot) continue;
            observer.unobserve(entry.target);
            void renderMathSlot(slot, options.locale).then(result => {
                if (!disposed && options.generation === options.currentGeneration()) options.onResult(slot, result);
            });
        }
    }, { root: options.scrollRoot, rootMargin: '600px 0px', threshold: 0 });
    for (const slot of options.slots) {
        const element = options.container.querySelector(`[data-render-slot="${CSS.escape(slot.id)}"]`);
        if (element) { byElement.set(element, slot); observer.observe(element); }
    }
    return { dispose: () => { disposed = true; observer.disconnect(); byElement.clear(); } };
}
