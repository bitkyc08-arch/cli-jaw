import type { RowKey, TurnStreamAction } from '../types.ts';
import type {
    MessagesPageClient,
    MessagesPageFetchResult,
    MessagesPageOptions,
} from './messages-page-client.ts';
import { diagnoseHistoryPageOverlap, mergeHistoryPage } from './merge-history-page.ts';
import { evaluateHistoryPageProgress } from './history-page-progress.ts';

const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_BACKFILL_MAX_PAGES = 10;
const DEFAULT_BACKFILL_MAX_MESSAGES = 2_000;

export type HistoryLoadPhase = 'idle' | 'loading' | 'backfilling' | 'error' | 'suggestion';

export interface HistoryControllerState {
    phase: HistoryLoadPhase;
    oldestCursor: number | null;
    exhausted: boolean;
    needsBackfill: boolean;
    error: unknown | null;
    pagesBackfilled: number;
    messagesBackfilled: number;
}

export type HistoryLoadResult =
    | { status: 'merged'; messageCount: number }
    | { status: 'exhausted' }
    | { status: 'aborted' }
    | { status: 'stale' }
    | { status: 'failed'; error: unknown }
    | { status: 'backfill-complete'; pages: number; messages: number }
    | { status: 'backfill-bounded'; pages: number; messages: number };

export interface HistoryControllerOptions {
    client: MessagesPageClient;
    apply(actions: readonly TurnStreamAction[]): void;
    getExistingRowKeys(): Iterable<RowKey>;
    pageLimit?: number;
    backfillMaxPages?: number;
    backfillMaxMessages?: number;
}

export interface HistoryController {
    setScope(scopeKey: string): void;
    loadInitial(): Promise<HistoryLoadResult>;
    loadOlder(): Promise<HistoryLoadResult>;
    handleReplayGap(): Promise<HistoryLoadResult>;
    retry(): Promise<HistoryLoadResult>;
    getState(): HistoryControllerState;
    subscribe(listener: () => void): () => void;
    abort(): void;
}

export function createHistoryController(options: HistoryControllerOptions): HistoryController {
    const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    const maxPages = options.backfillMaxPages ?? DEFAULT_BACKFILL_MAX_PAGES;
    const maxMessages = options.backfillMaxMessages ?? DEFAULT_BACKFILL_MAX_MESSAGES;
    const listeners = new Set<() => void>();
    const pageFlights = new Map<string, Promise<MessagesPageFetchResult>>();
    const loadFlights = new Map<string, Promise<HistoryLoadResult>>();
    let scopeGeneration = 0;
    let backfillFlight: Promise<HistoryLoadResult> | null = null;
    let retryOperation: (() => Promise<HistoryLoadResult>) | null = null;
    let state: HistoryControllerState = {
        phase: 'idle', oldestCursor: null, exhausted: false, needsBackfill: false,
        error: null, pagesBackfilled: 0, messagesBackfilled: 0,
    };

    function emit(): void {
        for (const listener of listeners) listener();
    }

    function update(patch: Partial<HistoryControllerState>): void {
        state = { ...state, ...patch };
        emit();
    }

    function setScope(scopeKey: string): void {
        scopeGeneration += 1;
        options.client.beginScope(scopeKey);
        pageFlights.clear();
        loadFlights.clear();
        backfillFlight = null;
        retryOperation = null;
        state = {
            phase: 'idle', oldestCursor: null, exhausted: false, needsBackfill: false,
            error: null, pagesBackfilled: 0, messagesBackfilled: 0,
        };
        emit();
    }

    function flightKey(opts: MessagesPageOptions): string {
        return opts.before === undefined ? 'latest' : `before:${opts.before}`;
    }

    function fetchPage(opts: MessagesPageOptions): Promise<MessagesPageFetchResult> {
        const key = flightKey(opts);
        const existing = pageFlights.get(key);
        if (existing) return existing;
        const promise = options.client.fetch(opts).finally(() => {
            if (pageFlights.get(key) === promise) pageFlights.delete(key);
        });
        pageFlights.set(key, promise);
        return promise;
    }

    function loadPage(opts: MessagesPageOptions): Promise<HistoryLoadResult> {
        const flightKey = opts.before === undefined ? 'latest' : `before:${opts.before}`;
        const existing = loadFlights.get(flightKey);
        if (existing) return existing;
        const generation = scopeGeneration;
        if (state.phase !== 'backfilling') update({ phase: 'loading', error: null });
        const promise = fetchPage({ ...opts, limit: pageLimit })
            .then((result): HistoryLoadResult => {
                if (generation !== scopeGeneration) return { status: 'stale' };
                if (result.status === 'aborted') return { status: 'aborted' };
                if (result.status === 'stale') return { status: 'stale' };
                const { page } = result;
                if (page.data.length === 0) {
                    update({ phase: state.phase === 'backfilling' ? 'backfilling' : 'idle', exhausted: true });
                    return { status: 'exhausted' };
                }
                options.apply([mergeHistoryPage(page)]);
                const exhausted = page.pageInfo.hasMoreBefore === false;
                // CF-3 — a same or non-decreasing cursor is no-progress, not a
                // legitimate boundary (the contract is exclusive `id < before`).
                // Without this guard, a server that repeats the cursor loops
                // loadOlder forever.
                const previousCursor = state.oldestCursor;
                const { noProgress } = evaluateHistoryPageProgress(previousCursor, page.pageInfo.oldestCursor);
                update({
                    phase: state.phase === 'backfilling' ? 'backfilling' : 'idle',
                    oldestCursor: page.pageInfo.oldestCursor,
                    exhausted: exhausted || noProgress,
                    error: null,
                });
                return { status: 'merged', messageCount: page.data.length };
            })
            .catch((error: unknown): HistoryLoadResult => {
                if (generation !== scopeGeneration) return { status: 'stale' };
                retryOperation = () => loadPage(opts);
                update({ phase: 'error', error });
                return { status: 'failed', error };
            })
            .finally(() => {
                if (loadFlights.get(flightKey) === promise) loadFlights.delete(flightKey);
            });
        loadFlights.set(flightKey, promise);
        return promise;
    }

    function loadInitial(): Promise<HistoryLoadResult> {
        return loadPage({});
    }

    function loadOlder(): Promise<HistoryLoadResult> {
        if (state.exhausted || state.oldestCursor === null) return Promise.resolve({ status: 'exhausted' });
        return loadPage({ before: state.oldestCursor });
    }

    function runBackfill(): Promise<HistoryLoadResult> {
        if (backfillFlight) return backfillFlight;
        const generation = scopeGeneration;
        const baselineRows = new Set(options.getExistingRowKeys());
        update({
            phase: 'backfilling', needsBackfill: true, error: null,
            pagesBackfilled: 0, messagesBackfilled: 0,
        });
        retryOperation = runBackfill;

        const promise = (async (): Promise<HistoryLoadResult> => {
            let before: number | undefined;
            let pages = 0;
            let messages = 0;
            const seenCursors = new Set<number>();
            while (pages < maxPages && messages < maxMessages) {
                const result = await fetchPage({
                    limit: Math.min(pageLimit, maxMessages - messages),
                    ...(before === undefined ? {} : { before }),
                });
                if (generation !== scopeGeneration) return { status: 'stale' };
                if (result.status === 'aborted') return { status: 'aborted' };
                if (result.status === 'stale') return { status: 'stale' };
                const { page } = result;
                pages += 1;
                messages += page.data.length;
                const overlap = diagnoseHistoryPageOverlap(page, baselineRows);
                const actions: TurnStreamAction[] = [];
                if (page.data.length > 0) actions.push(mergeHistoryPage(page));
                if (overlap.hasOverlap) actions.push({ kind: 'backfill_merged' });
                if (actions.length > 0) options.apply(actions);
                update({ pagesBackfilled: pages, messagesBackfilled: messages });
                if (overlap.hasOverlap) {
                    retryOperation = null;
                    update({ phase: 'idle', needsBackfill: false, error: null });
                    return { status: 'backfill-complete', pages, messages };
                }
                const cursor = page.pageInfo.oldestCursor;
                if (page.data.length === 0 || page.pageInfo.hasMoreBefore === false || cursor === null || seenCursors.has(cursor)) {
                    update({ phase: 'suggestion', needsBackfill: true });
                    return { status: 'backfill-bounded', pages, messages };
                }
                seenCursors.add(cursor);
                before = cursor;
            }
            update({ phase: 'suggestion', needsBackfill: true });
            return { status: 'backfill-bounded', pages, messages };
        })().catch((error: unknown): HistoryLoadResult => {
            if (generation !== scopeGeneration) return { status: 'stale' };
            update({ phase: 'error', needsBackfill: true, error });
            return { status: 'failed', error };
        }).finally(() => {
            if (backfillFlight === promise) backfillFlight = null;
        });
        backfillFlight = promise;
        return promise;
    }

    function handleReplayGap(): Promise<HistoryLoadResult> {
        options.apply([{ kind: 'invalidation', reason: 'replay_gap' }]);
        return runBackfill();
    }

    function retry(): Promise<HistoryLoadResult> {
        return retryOperation?.() ?? Promise.resolve(state.exhausted
            ? { status: 'exhausted' }
            : { status: 'aborted' });
    }

    function abort(): void {
        scopeGeneration += 1;
        options.client.abortAll();
        pageFlights.clear();
        loadFlights.clear();
        backfillFlight = null;
        retryOperation = null;
        update({ phase: 'idle', error: null });
    }

    return {
        setScope,
        loadInitial,
        loadOlder,
        handleReplayGap,
        retry,
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        abort,
    };
}
