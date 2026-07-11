import { createRoot } from 'react-dom/client';
import { HistoryLoadBoundary } from './HistoryLoadBoundary.tsx';
import type {
    HistoryController,
    HistoryControllerState,
    HistoryLoadResult,
} from './history-controller.ts';

interface HistoryBoundaryHarness {
    intersect(): void;
    observerReady(): boolean;
    setState(patch: Partial<HistoryControllerState>): void;
    retryCount(): number;
}

declare global {
    interface Window {
        __jawHistoryPagingHarness?: HistoryBoundaryHarness;
    }
}

export function mountHistoryLoadBoundaryHarness(root: Element = document.querySelector('#dashboard2-root')!): void {
    const listeners = new Set<() => void>();
    let state: HistoryControllerState = {
        phase: 'idle', oldestCursor: 200, exhausted: false, needsBackfill: false,
        error: null, pagesBackfilled: 0, messagesBackfilled: 0,
    };
    let observerCallback: IntersectionObserverCallback | null = null;
    let retries = 0;
    const notify = () => listeners.forEach(listener => listener());
    const merged = (): HistoryLoadResult => ({ status: 'merged', messageCount: 1 });
    const controller: HistoryController = {
        setScope() {},
        loadInitial: async () => merged(),
        loadOlder: async () => {
            state = { ...state, phase: 'loading' };
            notify();
            return merged();
        },
        handleReplayGap: async () => ({ status: 'aborted' }),
        retry: async () => {
            retries += 1;
            state = { ...state, phase: 'idle', error: null };
            notify();
            return merged();
        },
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        abort() {},
    };

    createRoot(root).render(
        <HistoryLoadBoundary
            controller={controller}
            createObserver={callback => {
                observerCallback = callback;
                return { observe() {}, disconnect() {} };
            }}
        />,
    );

    window.__jawHistoryPagingHarness = {
        intersect() {
            observerCallback?.([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
        },
        observerReady: () => observerCallback !== null,
        setState(patch) {
            state = { ...state, ...patch };
            notify();
        },
        retryCount: () => retries,
    };
}
