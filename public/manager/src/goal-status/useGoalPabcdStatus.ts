import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    createGoalPabcdStatusClient,
    type GoalPabcdStatusClient,
    type GoalPabcdStatusSnapshot,
} from './goal-pabcd-status-client';

type GoalPabcdStatusState = {
    snapshot: GoalPabcdStatusSnapshot | null;
    loading: boolean;
    error: string;
    lastReason: string;
    refresh: () => Promise<void>;
};

type EventSourceLike = Pick<EventSource, 'onmessage' | 'onerror' | 'close'>;
export type GoalPabcdEventSourceCtor = new (url: string) => EventSourceLike;

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function eventsUrl(baseUrl?: string): string {
    if (baseUrl) return `${baseUrl}/api/events`;
    if (typeof window !== 'undefined' && window.location.origin) return `${window.location.origin}/api/events`;
    return '/api/events';
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function statusRefreshReason(frame: Record<string, unknown>): string | null {
    const event = String(frame['event'] || '');
    if (frame['topic'] === 'goal' || event.startsWith('goal_')) return event || 'goal';
    if (event === 'orc_state') return event;
    if (event === 'heartbeat_pending') return event;
    if (frame['topic'] === 'worker' && typeof frame['event'] === 'string') return String(frame['event']);
    if (frame['topic'] === 'agent' && frame['isEmployee'] === true) {
        if (event === 'agent_status' || event === 'agent_done') return event;
    }
    if (frame['topic'] === 'system' && event === 'replay_gap') return event;
    return null;
}

export function useGoalPabcdStatus(
    clientOverride?: GoalPabcdStatusClient,
    options: { EventSourceImpl?: GoalPabcdEventSourceCtor; baseUrl?: string } = {},
): GoalPabcdStatusState {
    const client = useMemo(() => {
        if (clientOverride) return clientOverride;
        return createGoalPabcdStatusClient(options.baseUrl ? { baseUrl: options.baseUrl } : {});
    }, [clientOverride, options.baseUrl]);
    const [snapshot, setSnapshot] = useState<GoalPabcdStatusSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [lastReason, setLastReason] = useState('hydrated');

    const refresh = useCallback(async () => {
        try {
            const next = await client.readStatus();
            setSnapshot(next);
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
        void client.readStatus().then(
            next => {
                if (cancelled) return;
                setSnapshot(next);
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
        const EventSourceImpl = options.EventSourceImpl ?? EventSource;
        const source = new EventSourceImpl(eventsUrl(options.baseUrl));
        source.onmessage = (event: MessageEvent) => {
            let frame: unknown;
            try {
                frame = JSON.parse(String(event.data)) as unknown;
            } catch {
                return;
            }
            if (!isObject(frame)) return;
            const reason = statusRefreshReason(frame);
            if (!reason) return;
            setLastReason(reason);
            void refresh();
        };
        source.onerror = () => {
            setError('Goal/PABCD status event stream disconnected; retrying.');
        };
        return () => source.close();
    }, [options.EventSourceImpl, options.baseUrl, refresh]);

    return { snapshot, loading, error, lastReason, refresh };
}
