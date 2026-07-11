import type { TurnSegmentDetailRef } from '../../../../../src/shared/chat-events.ts';

export type DetailLoadResult =
    | { status: 'ready'; detail: unknown }
    | { status: 'unavailable' }
    | { status: 'aborted' }
    | { status: 'stale' };

export interface DetailLoaderStore {
    beginFetch(): number;
    resolveFetch(token: number, apply: () => void): boolean;
    putDetail(key: string, detail: unknown, pinned?: boolean): void;
}

export interface DetailLoader {
    load(ref: TurnSegmentDetailRef, pinned?: boolean): Promise<DetailLoadResult>;
    abort(refOrKey: TurnSegmentDetailRef | string): void;
    disposeAll(): void;
}

export const DETAIL_UNAVAILABLE = Object.freeze({ status: 'unavailable' as const });

export function detailKey(ref: TurnSegmentDetailRef): string {
    return `${ref.traceRunId}#${ref.traceSeq}`;
}

function errorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const status = Reflect.get(error, 'status');
    if (typeof status === 'number') return status;
    const response = Reflect.get(error, 'response');
    if (!response || typeof response !== 'object') return null;
    const responseStatus = Reflect.get(response, 'status');
    return typeof responseStatus === 'number' ? responseStatus : null;
}

function isAbortError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && Reflect.get(error, 'name') === 'AbortError');
}

export function createDetailLoader(
    fetchDetail: (ref: TurnSegmentDetailRef, signal: AbortSignal) => Promise<unknown>,
    store: DetailLoaderStore,
): DetailLoader {
    const inFlight = new Map<string, { controller: AbortController; promise: Promise<DetailLoadResult> }>();
    const unavailable = new Set<string>();

    function load(ref: TurnSegmentDetailRef, pinned = false): Promise<DetailLoadResult> {
        const key = detailKey(ref);
        if (unavailable.has(key)) return Promise.resolve(DETAIL_UNAVAILABLE);
        const existing = inFlight.get(key);
        if (existing) return existing.promise;

        const controller = new AbortController();
        const token = store.beginFetch();
        const promise = fetchDetail(ref, controller.signal)
            .then((detail): DetailLoadResult => {
                if (controller.signal.aborted) return { status: 'aborted' };
                const applied = store.resolveFetch(token, () => store.putDetail(key, detail, pinned));
                return applied ? { status: 'ready', detail } : { status: 'stale' };
            })
            .catch((error: unknown): DetailLoadResult => {
                if (controller.signal.aborted || isAbortError(error)) return { status: 'aborted' };
                const status = errorStatus(error);
                if (status === 404 || status === 410) {
                    const applied = store.resolveFetch(token, () => {
                        unavailable.add(key);
                        store.putDetail(key, DETAIL_UNAVAILABLE, pinned);
                    });
                    return applied ? DETAIL_UNAVAILABLE : { status: 'stale' };
                }
                throw error;
            })
            .finally(() => {
                if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
            });

        inFlight.set(key, { controller, promise });
        return promise;
    }

    function abort(refOrKey: TurnSegmentDetailRef | string): void {
        const key = typeof refOrKey === 'string' ? refOrKey : detailKey(refOrKey);
        inFlight.get(key)?.controller.abort();
    }

    function disposeAll(): void {
        for (const request of inFlight.values()) request.controller.abort();
        inFlight.clear();
    }

    return { load, abort, disposeAll };
}
