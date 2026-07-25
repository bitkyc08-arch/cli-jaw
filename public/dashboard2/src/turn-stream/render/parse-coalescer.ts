import { marked } from 'marked';
import { renderCopy } from './copy-catalog.js';
import { preParseMarkdown } from './pre-parse.js';
import { contentHash, getRenderCache, markdownCacheKey } from './render-cache.js';
import { sanitizeHtml, type SanitizedHtml } from './sanitize-policy.js';
import { extractMarkdownSlots, type MarkdownSlot } from './markdown-slot-manifest.js';

export interface RenderIdentity { scopeKey: string; turnId: string; segmentId: string }
export interface MarkdownRenderResult { html: SanitizedHtml; normalizedSource: string; cacheKey: string; finalized: boolean; readonly slots: readonly MarkdownSlot[] }
export interface ParseCoalescer { update(source: string): void; flushFinal(source?: string): MarkdownRenderResult; snapshot(): MarkdownRenderResult | null; dispose(): void }

const MEDIUM = 256 * 1024;
const OVERSIZE = 1024 * 1024;

function escapedPlaceholder(label: string, ordinal: number): string { return `\n\n> ${label} #${ordinal}\n\n`; }
function inertOpenConstructs(source: string): string {
    let result = source;
    const fences = [...source.matchAll(/^```/gm)];
    if (fences.length % 2) result = result.slice(0, fences.at(-1)?.index) + escapedPlaceholder(renderCopy('en', 'stream.fencePlaceholder'), fences.length);
    const math = [...result.matchAll(/\$\$/g)];
    if (math.length % 2) result = result.slice(0, math.at(-1)?.index) + escapedPlaceholder(renderCopy('en', 'stream.mathPlaceholder'), math.length);
    return result;
}

function parse(raw: string, finalized: boolean): MarkdownRenderResult {
    const normalizedSource = preParseMarkdown(raw).source;
    const cacheKey = markdownCacheKey(contentHash(normalizedSource));
    const cache = getRenderCache();
    if (finalized) {
        const cached = cache.get('markdown', cacheKey);
        if (typeof cached === 'string') {
            const extracted = extractMarkdownSlots(normalizedSource, contentHash(normalizedSource), true);
            return { html: cached as SanitizedHtml, normalizedSource, cacheKey, finalized: true, slots: extracted.slots };
        }
    }
    const parseSource = !finalized && normalizedSource.length > MEDIUM ? inertOpenConstructs(normalizedSource) : normalizedSource;
    // streaming parses stay slot-free: closed fences render as plain
    // pre/code via marked and raw TeX stays text — portals/highlight/KaTeX
    // are final-only per 082 §3.1/§3.5. Slot extraction runs only at finalize.
    const extracted = finalized
        ? extractMarkdownSlots(parseSource, contentHash(normalizedSource), true)
        : { source: parseSource, slots: [] as readonly MarkdownSlot[] };
    /*
     * marked emits a formatting newline after the outermost closing tag. Any
     * container that inherits white-space: pre-wrap — the user bubble does —
     * renders that as a real blank line, so a one-line message measured 68px
     * instead of 44px.
     *
     * Trimming only the outer edge is safe: whitespace a user actually meant to
     * keep lives INSIDE a tag (fenced code, for example), so it is untouched.
     *
     * Done before sanitizing so the sanitizer's branded return type survives.
     */
    const unsafe = marked.parse(extracted.source, { async: false }).trim();
    const html = sanitizeHtml(unsafe, 'markdown');
    const result = { html, normalizedSource, cacheKey, finalized, slots: extracted.slots };
    if (finalized) cache.set('markdown', cacheKey, html);
    return result;
}

export function renderFinalMarkdown(raw: string): MarkdownRenderResult { return parse(raw, true); }

export function createParseCoalescer(options: { identity: RenderIdentity; onPublish(result: MarkdownRenderResult): void; now?: () => number; schedule?: (delayMs: number, callback: () => void) => unknown; cancel?: (handle: unknown) => void }): ParseCoalescer {
    const schedule = options.schedule ?? ((delay, callback) => setTimeout(callback, delay));
    const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let source = ''; let latest: MarkdownRenderResult | null = null; let handle: unknown = null;
    let generation = 0; let disposed = false;
    const publish = (result: MarkdownRenderResult): void => {
        latest = result;
        if (!result.finalized) getRenderCache().setLiveMarkdown(options.identity.scopeKey, result.cacheKey, result.html);
        options.onPublish(result);
    };
    const update = (next: string): void => {
        if (disposed) return;
        source = next; generation += 1;
        if (handle !== null) cancel(handle);
        const mine = generation; const delay = next.length <= MEDIUM ? 40 : 100;
        handle = schedule(delay, () => {
            handle = null;
            if (disposed || mine !== generation) return;
            if (source.length > OVERSIZE) {
                if (latest) publish(latest);
                return;
            }
            publish(parse(source, false));
        });
    };
    const flushFinal = (next?: string): MarkdownRenderResult => {
        if (next !== undefined) source = next;
        generation += 1; if (handle !== null) { cancel(handle); handle = null; }
        const result = renderFinalMarkdown(source);
        getRenderCache().clearLiveMarkdown(options.identity.scopeKey);
        if (latest?.finalized && latest.cacheKey === result.cacheKey) return latest;
        if (!disposed) publish(result);
        return result;
    };
    return { update, flushFinal, snapshot: () => latest, dispose: () => { disposed = true; generation += 1; if (handle !== null) cancel(handle); handle = null; } };
}
