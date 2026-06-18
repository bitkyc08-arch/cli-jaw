import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    BackgroundTaskApiError,
    createBackgroundTaskClient,
    subscribeToBackgroundTaskUpdates,
    type BackgroundTaskClient,
    type BackgroundTaskRow,
    type BackgroundTaskStatus,
    type BackgroundTaskUpdate,
} from './background-task-client';

type BackgroundTaskMonitorState = {
    tasks: BackgroundTaskRow[];
    loading: boolean;
    error: string;
    lastUpdate: BackgroundTaskUpdate | null;
    refresh: () => Promise<void>;
    cancelTask: (taskId: string) => Promise<void>;
    retryTask: (task: BackgroundTaskRow) => Promise<void>;
};

export function sortBackgroundTasks(tasks: BackgroundTaskRow[]): BackgroundTaskRow[] {
    return [...tasks].sort((left, right) => {
        const leftTime = Date.parse(left.createdAt ?? left.startedAt ?? left.completedAt ?? '');
        const rightTime = Date.parse(right.createdAt ?? right.startedAt ?? right.completedAt ?? '');
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
}

export function countBackgroundTasksByStatus(tasks: BackgroundTaskRow[]): Record<BackgroundTaskStatus, number> {
    return tasks.reduce<Record<BackgroundTaskStatus, number>>((counts, task) => {
        counts[task.status] += 1;
        return counts;
    }, { running: 0, complete: 0, failed: 0, cancelled: 0, orphaned: 0 });
}

function errorText(err: unknown): string {
    if (err instanceof BackgroundTaskApiError && err.status === 409 && err.existingId) {
        return `Already running as ${err.existingId}.`;
    }
    return err instanceof Error ? err.message : String(err);
}

export function useBackgroundTasks(clientOverride?: BackgroundTaskClient): BackgroundTaskMonitorState {
    const client = useMemo(() => clientOverride ?? createBackgroundTaskClient(), [clientOverride]);
    const [tasks, setTasks] = useState<BackgroundTaskRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [lastUpdate, setLastUpdate] = useState<BackgroundTaskUpdate | null>(null);

    const refresh = useCallback(async () => {
        try {
            const next = await client.listTasks({ limit: 50 });
            setTasks(sortBackgroundTasks(next));
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
        void client.listTasks({ limit: 50 }).then(
            next => {
                if (cancelled) return;
                setTasks(sortBackgroundTasks(next));
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
        const sub = subscribeToBackgroundTaskUpdates({
            onUpdate: update => {
                setLastUpdate(update);
                void refresh();
            },
            onReplayGap: () => {
                void refresh();
            },
            onError: () => {
                setError('Background task event stream disconnected; retrying.');
            },
        });
        return () => sub.close();
    }, [refresh]);

    const cancelTask = useCallback(async (taskId: string) => {
        try {
            await client.cancelTask(taskId);
            await refresh();
        } catch (err) {
            setError(errorText(err));
        }
    }, [client, refresh]);

    const retryTask = useCallback(async (task: BackgroundTaskRow) => {
        try {
            await client.createTask({ kind: task.kind, spec: task.spec, originMeta: task.originMeta });
            await refresh();
        } catch (err) {
            setError(errorText(err));
        }
    }, [client, refresh]);

    return { tasks, loading, error, lastUpdate, refresh, cancelTask, retryTask };
}
