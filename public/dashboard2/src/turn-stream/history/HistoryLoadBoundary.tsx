import { RefreshCw } from '@lucide/icons';
import { useEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import type { HistoryController } from './history-controller.ts';

export type HistoryIntersectionObserver = Pick<IntersectionObserver, 'disconnect' | 'observe'>;
export type HistoryIntersectionObserverFactory = (
    callback: IntersectionObserverCallback,
) => HistoryIntersectionObserver;

export interface HistoryLoadBoundaryProps {
    controller: HistoryController;
    createObserver?: HistoryIntersectionObserverFactory;
}

function defaultObserver(callback: IntersectionObserverCallback): HistoryIntersectionObserver {
    return new IntersectionObserver(callback, { rootMargin: '160px 0px 0px' });
}

export function HistoryLoadBoundary({
    controller,
    createObserver = defaultObserver,
}: HistoryLoadBoundaryProps): JSX.Element {
    const sentinelRef = useRef<HTMLDivElement>(null);
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || state.exhausted || state.phase !== 'idle') return;
        const observer = createObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) void controller.loadOlder();
        });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [controller, createObserver, state.exhausted, state.phase]);

    return (
        <div className="d2-history-boundary" data-history-state={state.phase}>
            <div ref={sentinelRef} className="d2-history-sentinel" aria-hidden="true" />
            {state.phase === 'loading' || state.phase === 'backfilling' ? (
                <div className="d2-history-status" role="status">Loading earlier messages...</div>
            ) : null}
            {state.phase === 'error' ? (
                <button className="d2-history-retry" type="button" onClick={() => void controller.retry()}>
                    <Icon icon={RefreshCw} size={14} />
                    <span>Retry history</span>
                </button>
            ) : null}
            {state.phase === 'suggestion' ? (
                <div className="d2-history-status" role="status">History limit reached. Reload the latest snapshot.</div>
            ) : null}
            {state.exhausted && state.phase === 'idle' ? (
                <div className="d2-history-status" role="status">Start of history</div>
            ) : null}
        </div>
    );
}
