import { highlightCode, normalizeCodeLanguage, type HighlightResult } from './highlight-languages';

/**
 * D2 (260803 unit, 020 phase): `highlightCode` is pure but was called straight
 * from a render body, so a large block was re-tokenized on every parent render
 * and again every time a virtualized row scrolled back into view.
 *
 * Bounds are deliberately smaller than t3code's 500 entries / 50MB
 * (apps/web/src/components/ChatMarkdown.tsx:110): highlighting is one panel
 * among many here and this phase exists to reduce RAM, not trade it.
 */
const MAX_ENTRIES = 200;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Skip highlighting entirely past this size. hljs cost is superlinear in
 * pathological input, and a minified bundle pasted into a message should not
 * stall the main thread. t3code caps per line (tokenizeMaxLineLength: 1_000);
 * hljs has no such knob, so we cap the whole block instead.
 */
const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * Reject pathological single lines before hljs ever sees them. A minified
 * bundle pasted into a message is one enormous line, and tokenizer cost is
 * superlinear there. t3code enforces the same idea with
 * `tokenizeMaxLineLength: 1_000` (apps/web/src/components/DiffWorkerPoolProvider.tsx:75);
 * hljs exposes no equivalent option, so we pre-check instead.
 */
const MAX_HIGHLIGHT_LINE_CHARS = 1_000;

type Entry = { result: HighlightResult; bytes: number };

// Map preserves insertion order, which gives LRU for free: delete + re-set on
// hit moves an entry to the newest position.
const cache = new Map<string, Entry>();
let cachedBytes = 0;

function estimateBytes(key: string, result: HighlightResult): number {
    // The key embeds a full copy of the source, so counting only the html
    // would undercount retention by roughly half.
    return (key.length + result.html.length) * 2;
}

function evictUntilWithinBounds(): void {
    while ((cache.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) && cache.size > 0) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        const entry = cache.get(oldest.value);
        cache.delete(oldest.value);
        if (entry) cachedBytes -= entry.bytes;
    }
}

function escapeHtml(code: string): string {
    return code.replace(/[&<>"']/g, value => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[value] ?? value);
}

function hasOverlongLine(code: string): boolean {
    let lineStart = 0;
    for (let i = 0; i < code.length; i += 1) {
        if (code.charCodeAt(i) !== 10) continue;
        if (i - lineStart > MAX_HIGHLIGHT_LINE_CHARS) return true;
        lineStart = i + 1;
    }
    return code.length - lineStart > MAX_HIGHLIGHT_LINE_CHARS;
}

export function highlightCodeCached(code: string, language?: string): HighlightResult {
    // Normalize first: `TypeScript`, `typescript`, and `language-typescript`
    // all resolve to one result, so they must share one cache entry.
    const normalized = normalizeCodeLanguage(language);

    if (code.length > MAX_HIGHLIGHT_CHARS || hasOverlongLine(code)) {
        return { html: escapeHtml(code), language: normalized, highlighted: false };
    }

    const key = `${normalized}\u0000${code}`;
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit.result;
    }

    const result = highlightCode(code, language);
    const bytes = estimateBytes(key, result);
    // A single oversized entry would evict everything else for no benefit.
    if (bytes <= MAX_BYTES) {
        cache.set(key, { result, bytes });
        cachedBytes += bytes;
        evictUntilWithinBounds();
    }
    return result;
}

/** Test seam. */
export function __resetHighlightCache(): void {
    cache.clear();
    cachedBytes = 0;
}

export function __highlightCacheStats(): { entries: number; bytes: number } {
    return { entries: cache.size, bytes: cachedBytes };
}
