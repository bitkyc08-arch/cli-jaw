import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    createWorkerProgressClient,
    subscribeToWorkerProgressEvents,
    type WorkerProgressClient,
    type WorkerProgressRun,
    type WorkerProgressSnapshot,
} from './worker-progress-client';

type WorkerProgressMonitorState = {
    workers: WorkerProgressSnapshot[];
    loading: boolean;
    error: string;
    lastReason: string;
    refresh: () => Promise<void>;
};

function runOf(snapshot: WorkerProgressSnapshot): WorkerProgressRun | null {
    return snapshot.current ?? snapshot.previous;
}

function updatedAt(snapshot: WorkerProgressSnapshot): number {
    const run = runOf(snapshot);
    const stamp = run?.progressUpdatedAt ?? run?.completedAt ?? run?.startedAt ?? snapshot.generatedAt;
    return Number.isFinite(stamp) ? stamp : 0;
}

export function sortWorkerProgress(workers: WorkerProgressSnapshot[]): WorkerProgressSnapshot[] {
    return [...workers].sort((left, right) => {
        if (Boolean(left.current) !== Boolean(right.current)) return left.current ? -1 : 1;
        return updatedAt(right) - updatedAt(left);
    });
}

export function countWorkerProgress(workers: WorkerProgressSnapshot[]): { running: number; previous: number; attention: number } {
    return workers.reduce((counts, worker) => {
        if (worker.current) counts.running += 1;
        else if (worker.previous) counts.previous += 1;
        if (runOf(worker)?.attention) counts.attention += 1;
        return counts;
    }, { running: 0, previous: 0, attention: 0 });
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function useWorkerProgress(clientOverride?: WorkerProgressClient): WorkerProgressMonitorState {
    const client = useMemo(() => clientOverride ?? createWorkerProgressClient(), [clientOverride]);
    const [workers, setWorkers] = useState<WorkerProgressSnapshot[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [lastReason, setLastReason] = useState('hydrated');

    const refresh = useCallback(async () => {
        try {
            const next = await client.listWorkers();
            setWorkers(sortWorkerProgress(next));
            setError('');
        } catch (err) {
            setError(errorText(err));
        } finally {
            setLoading(false);
        }
    }, [client]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        void client.listWorkers().then(
            next => {
                if (cancelled) return;
                setWorkers(sortWorkerProgress(next));
                setError('');
                setLoading(false);
            },
            err => {
                if (cancelled) return;
                setError(errorText(err));
                setLoading(false);
            },
        );
        return () => { cancelled = true; };
    }, [client]);

    useEffect(() => {
        const sub = subscribeToWorkerProgressEvents({
            onRefreshNeeded: reason => {
                setLastReason(reason);
                void refresh();
            },
            onReplayGap: () => {
                setLastReason('replay_gap');
            },
            onError: () => {
                setError('Worker progress event stream disconnected; retrying.');
            },
        });
        return () => sub.close();
    }, [refresh]);

    return { workers, loading, error, lastReason, refresh };
}
