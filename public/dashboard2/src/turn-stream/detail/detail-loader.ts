import type { TurnSegmentDetailRef } from '../../../../../src/shared/chat-events.ts';
import type { TurnStore } from '../store/turn-store.ts';
import { fetchTraceDetail } from './detail-client.ts';
import { projectSparseLine } from './line-index.ts';

export type DetailPhase = 'idle' | 'opening' | 'loading-inline' | 'loading-range' | 'ready-inline' | 'ready-ranged' | 'unavailable' | 'gone' | 'stale-revision' | 'error';
export interface DetailChunk { offset: number; endExclusive: number; text: string; firstLine: number; lastLine: number; ansiStateBefore: string | null; ansiStateAfter: string | null }
export interface DetailSnapshot { phase: DetailPhase; resolvedRevision: string | null; totalBytes: number | null; lineCount: number | null; inlineText: string | null; chunks: readonly DetailChunk[]; error: string | null }
export interface DetailRangeResult { ok: boolean; chunk?: DetailChunk; nextOffset?: number | null; error?: string }
export interface DetailController {
    open(): Promise<DetailSnapshot>;
    loadRange(offset: number, limit?: number): Promise<DetailRangeResult>;
    seekLine(line: number): Promise<DetailRangeResult>;
    subscribe(listener: () => void): () => void;
    snapshot(): DetailSnapshot;
    pin(reason: 'expanded' | 'copy' | 'search'): void;
    unpin(reason: 'expanded' | 'copy' | 'search'): void;
    collapse(now?: number): void;
    abort(): void;
    dispose(): void;
}

const controllers = new WeakMap<TurnStore, Map<string, DetailController>>();
const registeredStores = new WeakSet<TurnStore>();
const RANGE_LIMIT = 262_144;

function baseKey(ref: TurnSegmentDetailRef): string { return `${ref.traceRunId}#${ref.traceSeq}`; }
function revisionKey(ref: TurnSegmentDetailRef, revision: string): string { return `${baseKey(ref)}@${revision}`; }

function contentHash(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let hash = 0x811c9dc5;
    for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${bytes.byteLength}`;
}

function initial(): DetailSnapshot {
    return { phase: 'idle', resolvedRevision: null, totalBytes: null, lineCount: null, inlineText: null, chunks: [], error: null };
}

export function getDetailController(store: TurnStore, ref: TurnSegmentDetailRef, options?: { fetcher?: typeof fetch; apiBase?: string; now?: () => number }): DetailController {
    const resolvedOptions = options ?? {};
    let storeControllers = controllers.get(store);
    if (!storeControllers) { storeControllers = new Map(); controllers.set(store, storeControllers); }
    const id = baseKey(ref);
    const memoized = storeControllers.get(id);
    if (memoized) return memoized;

    let state = initial();
    let generation = 0;
    let request: AbortController | null = null;
    let openPromise: Promise<DetailSnapshot> | null = null;
    let cacheKey = revisionKey(ref, 'pending');
    let rangeRevision: string | null = null;
    let disposed = false;
    const listeners = new Set<() => void>();
    const pins = new Set<'expanded' | 'copy' | 'search'>();
    const now = resolvedOptions.now ?? Date.now;

    const publish = (next: DetailSnapshot) => {
        state = next;
        for (const listener of listeners) listener();
    };
    const patch = (next: Partial<DetailSnapshot>) => publish({ ...state, ...next });
    const current = (token: number) => !disposed && token === generation && !request?.signal.aborted;
    const commitCache = (key: string, snapshot: DetailSnapshot) => {
        cacheKey = key;
        store.putDetail(key, snapshot, pins.has('expanded'));
        for (const reason of pins) store.pinDetail(key, reason);
    };

    async function loadRange(offset: number, limit = RANGE_LIMIT): Promise<DetailRangeResult> {
        if (disposed) return { ok: false, error: 'disposed' };
        request?.abort();
        request = new AbortController();
        const token = ++generation;
        patch({ phase: 'loading-range', error: null });
        try {
            let result = await fetchTraceDetail(ref.traceRunId, ref.traceSeq, { offset, limit, signal: request.signal, ...resolvedOptions });
            if (result.kind === 'revision-changed') {
                const metadata = await fetchTraceDetail(ref.traceRunId, ref.traceSeq, { signal: request.signal, ...resolvedOptions });
                if (!current(token)) return { ok: false, error: 'stale' };
                if (metadata.kind === 'range-required') {
                    patch({ phase: 'stale-revision', error: result.error, totalBytes: metadata.totalBytes });
                    return { ok: false, error: result.error };
                }
                result = metadata;
            }
            if (!current(token)) return { ok: false, error: 'stale' };
            if (result.kind === 'not-found') { patch({ phase: 'unavailable', error: result.error }); return { ok: false, error: result.error }; }
            if (result.kind === 'gone') { patch({ phase: 'gone', error: result.error }); return { ok: false, error: result.error }; }
            if (result.kind !== 'range') {
                const error = 'error' in result ? result.error : `unexpected_${result.kind}`;
                patch({ phase: result.kind === 'revision-changed' ? 'stale-revision' : 'error', error });
                return { ok: false, error };
            }
            if (rangeRevision && rangeRevision !== result.data.revision) {
                patch({ phase: 'stale-revision', error: 'trace_payload_revision_changed' });
                return { ok: false, error: 'trace_payload_revision_changed' };
            }
            rangeRevision = result.data.revision;
            const chunk: DetailChunk = {
                offset: result.data.actualStart, endExclusive: result.data.actualEndExclusive, text: result.data.text,
                firstLine: result.data.line.first, lastLine: result.data.line.last,
                ansiStateBefore: result.data.boundary.ansiStateBefore, ansiStateAfter: result.data.boundary.ansiStateAfter,
            };
            const chunks = [...state.chunks.filter(existing => existing.offset !== chunk.offset), chunk]
                .sort((a, b) => a.offset - b.offset);
            const next: DetailSnapshot = {
                ...state, phase: 'ready-ranged', resolvedRevision: rangeRevision,
                totalBytes: result.data.totalBytes, lineCount: Math.max(state.lineCount ?? 0, chunk.lastLine), chunks, error: null,
            };
            publish(next);
            commitCache(revisionKey(ref, rangeRevision), next);
            return { ok: true, chunk, nextOffset: result.data.nextOffset };
        } catch (error) {
            if (!current(token)) return { ok: false, error: 'aborted' };
            const message = error instanceof Error ? error.message : String(error);
            patch({ phase: 'error', error: message });
            return { ok: false, error: message };
        }
    }

    async function open(): Promise<DetailSnapshot> {
        if (openPromise) return openPromise;
        const cached = store.getDetail(cacheKey) as DetailSnapshot | null;
        if (cached) { store.touchDetail(cacheKey); publish(cached); return cached; }
        request?.abort();
        request = new AbortController();
        const token = ++generation;
        patch({ phase: 'opening', error: null });
        openPromise = (async () => {
            try {
                patch({ phase: 'loading-inline' });
                const result = await fetchTraceDetail(ref.traceRunId, ref.traceSeq, { signal: request!.signal, ...resolvedOptions });
                if (!current(token)) return state;
                if (result.kind === 'range-required') {
                    patch({ phase: 'loading-range', totalBytes: result.totalBytes });
                    await loadRange(0, result.chunkSize);
                    return state;
                }
                if (result.kind === 'not-found') patch({ phase: 'unavailable', error: result.error });
                else if (result.kind === 'gone') patch({ phase: 'gone', error: result.error });
                else if (result.kind === 'full') {
                    const revision = contentHash(result.data.raw);
                    const next: DetailSnapshot = {
                        phase: 'ready-inline', resolvedRevision: revision, totalBytes: new TextEncoder().encode(result.data.raw).byteLength,
                        lineCount: result.data.raw.split('\n').length, inlineText: result.data.raw, chunks: [], error: null,
                    };
                    publish(next);
                    commitCache(revisionKey(ref, revision), next);
                } else {
                    const error = result.kind === 'range' ? 'unexpected_range_response' : result.error;
                    patch({ phase: result.kind === 'revision-changed' ? 'stale-revision' : 'error', error });
                }
                return state;
            } catch (error) {
                if (current(token)) patch({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
                return state;
            } finally { openPromise = null; }
        })();
        return openPromise;
    }

    const controller: DetailController = {
        open,
        loadRange,
        seekLine(line) {
            const projection = projectSparseLine(state.chunks, line);
            return loadRange(projection?.offset ?? 0);
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        snapshot() { return state; },
        pin(reason) { pins.add(reason); store.pinDetail(cacheKey, reason); },
        unpin(reason) { pins.delete(reason); store.unpinDetail(cacheKey, reason); },
        collapse(at = now()) { controller.abort(); controller.unpin('expanded'); store.collapseDetail(cacheKey, at + 60_000); },
        abort() { generation += 1; request?.abort(); request = null; openPromise = null; },
        dispose() { if (disposed) return; controller.abort(); disposed = true; listeners.clear(); storeControllers!.delete(id); },
    };
    storeControllers.set(id, controller);
    if (!registeredStores.has(store)) {
        registeredStores.add(store);
        store.registerDetailDisposer(() => {
            for (const item of controllers.get(store)?.values() ?? []) item.dispose();
            controllers.delete(store);
        });
    }
    return controller;
}
