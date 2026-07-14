import {
    approvedGrammarInventory, isApprovedLanguage, normalizeLanguage, type ApprovedLanguage, type HighlightRequest, type HighlightResult, type PlainHighlight,
} from './code-block-contract.js';
import { getRenderCache, highlightCacheKey } from './render-cache.js';
import { sanitizeHtml, type SanitizedHtml } from './sanitize-policy.js';
import type { HighlightWorkerRequest, HighlightWorkerResult } from './highlight-worker.js';
import type * as ShikiRuntime from './shiki-runtime.js';

const MAIN_MAX = 8 * 1024;
const WORKER_MAX = 200 * 1024;
const MANUAL_MAX = 1024 * 1024;
const PRIORITY = { visible: 0, manual: 1, prewarm: 2 } as const;
const MAX_QUEUE = 128;
// single-copy runtime boundary (082 §3.6): all @shikijs bytes live behind
// this one dynamic import; the worker imports the SAME emitted module.
let runtimeModule: Promise<typeof ShikiRuntime> | null = null;
function loadShikiRuntime(): Promise<typeof ShikiRuntime> {
    return runtimeModule ??= import('./shiki-runtime.js');
}
export function escapeHighlightHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export async function highlightWithRuntime(code: string, language: ApprovedLanguage): Promise<SanitizedHtml> {
    const runtime = await loadShikiRuntime();
    return sanitizeHtml(await runtime.tokenizeCode(code, language), 'highlight');
}
export const grammarIds = approvedGrammarInventory;
export type HighlightRoute = 'plain' | 'main' | 'worker' | 'manual' | 'reject';
export interface HighlightMetrics { requests: number; cacheHits: number; workerInits: number; coldInitMs: number }
export interface HighlightHandle { promise: Promise<HighlightResult>; cancel(): void }

function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
export function routeHighlightRequest(request: HighlightRequest): HighlightRoute {
    if (request.streaming || request.openFence || !isApprovedLanguage(normalizeLanguage(request.language))) return 'plain';
    const size = bytes(request.code);
    if (size <= MAIN_MAX) return 'main';
    if (size <= WORKER_MAX) return 'worker';
    if (request.priority !== 'manual') return 'manual';
    return size <= MANUAL_MAX ? 'worker' : 'reject';
}

interface QueueItem { consumerId: string; request: HighlightRequest; resolve(value: HighlightResult): void; cancelled: boolean; order: number }
export class HighlightService {
    readonly metrics: HighlightMetrics = { requests: 0, cacheHits: 0, workerInits: 0, coldInitMs: 0 };
    private readonly generations = new Map<string, number>();
    private readonly queue: QueueItem[] = [];
    private running = false;
    private order = 0;
    private worker: Worker | null = null;
    private workerId = 0;

    bumpGeneration(consumerId: string): number {
        const next = (this.generations.get(consumerId) ?? 0) + 1;
        this.generations.set(consumerId, next); return next;
    }
    currentGeneration(consumerId: string): number { return this.generations.get(consumerId) ?? 0; }
    request(consumerId: string, raw: HighlightRequest): HighlightHandle {
        this.metrics.requests += 1;
        const request = { ...raw, language: normalizeLanguage(raw.language) };
        this.generations.set(consumerId, Math.max(this.currentGeneration(consumerId), request.generation));
        let item: QueueItem | undefined;
        const promise = new Promise<HighlightResult>(resolve => {
            item = { consumerId, request, resolve, cancelled: false, order: this.order++ };
            if (this.queue.length >= MAX_QUEUE) this.queue.pop()?.resolve(this.plain(request, 'Queue full'));
            this.queue.push(item); this.queue.sort((a, b) => PRIORITY[a.request.priority] - PRIORITY[b.request.priority] || a.order - b.order);
            void this.drain();
        });
        return { promise, cancel: () => {
            if (item && !item.cancelled) { item.cancelled = true; item.resolve(this.plain(item.request)); }
            this.bumpGeneration(consumerId);
        } };
    }
    private plain(request: HighlightRequest, error?: string): HighlightResult {
        const html: PlainHighlight = { kind: 'plain', source: request.code };
        return { html, language: request.language, cacheKey: highlightCacheKey(request.codeHash, request.language), generation: request.generation, ...(error ? { error } : {}) };
    }
    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        while (this.queue.length) {
            const item = this.queue.shift(); if (!item) break;
            if (item.cancelled) continue;
            const route = routeHighlightRequest(item.request);
            const key = highlightCacheKey(item.request.codeHash, item.request.language);
            const cached = getRenderCache().get('highlight', key);
            if (typeof cached === 'string') { this.metrics.cacheHits += 1; item.resolve({ html: cached as SanitizedHtml, language: item.request.language, cacheKey: key, generation: item.request.generation }); continue; }
            if (route === 'plain' || route === 'manual' || route === 'reject') { item.resolve(this.plain(item.request, route === 'reject' ? 'Code exceeds 1 MiB' : undefined)); continue; }
            const started = performance.now();
            const result = route === 'main' ? await this.runMain(item.request) : await this.runWorker(item.request);
            if (!item.cancelled && item.request.generation === this.currentGeneration(item.consumerId) && typeof result.html === 'string') {
                getRenderCache().setIfGenerationCurrent('highlight', key, result.html, item.request.generation, () => this.currentGeneration(item.consumerId));
            }
            if (!item.cancelled) item.resolve(result);
            if (!this.metrics.coldInitMs) this.metrics.coldInitMs = performance.now() - started;
            await new Promise<void>(resolve => typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 0));
        }
        this.running = false;
    }
    private async runMain(request: HighlightRequest): Promise<HighlightResult> {
        try {
            const html = await highlightWithRuntime(request.code, request.language as Parameters<typeof highlightWithRuntime>[1]);
            return { html, language: request.language, cacheKey: highlightCacheKey(request.codeHash, request.language), generation: request.generation };
        } catch (error) { return this.plain(request, error instanceof Error ? error.message : 'Highlight failed'); }
    }
    private runWorker(request: HighlightRequest): Promise<HighlightResult> {
        if (typeof Worker === 'undefined') return this.runMain(request);
        if (!this.worker) {
            this.worker = new Worker(new URL('./highlight-worker.ts', import.meta.url), { type: 'module' });
            this.metrics.workerInits += 1;
            // hand the worker the emitted shiki-runtime module URL so it
            // imports the same single-copy chunk instead of bundling its own
            void loadShikiRuntime().then(runtime => {
                this.worker?.postMessage({ kind: 'init', moduleUrl: runtime.runtimeModuleUrl });
            });
        }
        const id = ++this.workerId;
        return new Promise(resolve => {
            const listener = (event: MessageEvent<HighlightWorkerResult>) => {
                if (event.data.id !== id) return;
                this.worker?.removeEventListener('message', listener);
                const payload = event.data;
                if (typeof payload.rawHtml === 'string') {
                    // worker output is raw untrusted token html — sanitize on
                    // the main thread (DOMPurify requires a DOM)
                    const html = sanitizeHtml(payload.rawHtml, 'highlight');
                    resolve({ html, language: request.language, cacheKey: highlightCacheKey(request.codeHash, request.language), generation: request.generation });
                } else {
                    resolve(this.plain(request, payload.error ?? 'Highlight failed'));
                }
            };
            this.worker?.addEventListener('message', listener);
            const envelope: HighlightWorkerRequest = { kind: 'request', id, request }; this.worker?.postMessage(envelope);
        });
    }
}

let singleton: HighlightService | null = null;
export function getHighlightService(): HighlightService { return singleton ??= new HighlightService(); }
