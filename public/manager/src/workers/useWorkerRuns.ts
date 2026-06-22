import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    createWorkerRunsClient,
    type WorkerRunEvent,
    type WorkerRunOutput,
    type WorkerRunRecord,
    type WorkerRunsClient,
} from './worker-runs-client';
import { subscribeToWorkerProgressEvents } from './worker-progress-client';

export type WorkerRunEventState = {
    events: WorkerRunEvent[];
    loading: boolean;
    error: string;
};

export type WorkerRunOutputState = {
    output: WorkerRunOutput | null;
    loading: boolean;
    error: string;
};

type WorkerRunsState = {
    runs: WorkerRunRecord[];
    loading: boolean;
    error: string;
    lastReason: string;
    eventsByRunId: Record<string, WorkerRunEventState>;
    outputByRunId: Record<string, WorkerRunOutputState>;
    refresh: () => Promise<void>;
    loadEvents: (runId: string) => Promise<void>;
    loadOutput: (runId: string, input?: { offset?: number; limit?: number }) => Promise<void>;
};

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function sortWorkerRuns(runs: WorkerRunRecord[]): WorkerRunRecord[] {
    return [...runs].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function useWorkerRuns(clientOverride?: WorkerRunsClient): WorkerRunsState {
    const client = useMemo(() => clientOverride ?? createWorkerRunsClient(), [clientOverride]);
    const [runs, setRuns] = useState<WorkerRunRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [lastReason, setLastReason] = useState('hydrated');
    const [eventsByRunId, setEventsByRunId] = useState<Record<string, WorkerRunEventState>>({});
    const [outputByRunId, setOutputByRunId] = useState<Record<string, WorkerRunOutputState>>({});

    const refresh = useCallback(async () => {
        try {
            const next = await client.listRuns();
            setRuns(sortWorkerRuns(next));
            setError('');
        } catch (err) {
            setError(errorText(err));
        } finally {
            setLoading(false);
        }
    }, [client]);

    const loadEvents = useCallback(async (runId: string) => {
        setEventsByRunId(prev => ({
            ...prev,
            [runId]: { events: prev[runId]?.events ?? [], loading: true, error: '' },
        }));
        try {
            const events = await client.getRunEvents(runId);
            setEventsByRunId(prev => ({
                ...prev,
                [runId]: { events, loading: false, error: '' },
            }));
        } catch (err) {
            setEventsByRunId(prev => ({
                ...prev,
                [runId]: { events: prev[runId]?.events ?? [], loading: false, error: errorText(err) },
            }));
        }
    }, [client]);

    const loadOutput = useCallback(async (runId: string, input: { offset?: number; limit?: number } = {}) => {
        setOutputByRunId(prev => ({
            ...prev,
            [runId]: { output: prev[runId]?.output ?? null, loading: true, error: '' },
        }));
        try {
            const output = await client.readRunOutput(runId, input);
            setOutputByRunId(prev => ({
                ...prev,
                [runId]: { output, loading: false, error: '' },
            }));
        } catch (err) {
            setOutputByRunId(prev => ({
                ...prev,
                [runId]: { output: prev[runId]?.output ?? null, loading: false, error: errorText(err) },
            }));
        }
    }, [client]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        void client.listRuns().then(
            next => {
                if (cancelled) return;
                setRuns(sortWorkerRuns(next));
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
                if (reason.startsWith('worker_run_') || reason === 'replay_gap') void refresh();
            },
            onReplayGap: () => {
                setLastReason('replay_gap');
            },
            onError: () => {
                setError('Worker run event stream disconnected; retrying.');
            },
        });
        return () => sub.close();
    }, [refresh]);

    return { runs, loading, error, lastReason, eventsByRunId, outputByRunId, refresh, loadEvents, loadOutput };
}
