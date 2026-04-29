import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardInstance, ManagerEvent } from '../types';

const POLL_INTERVAL_MS = 5_000;
const MAX_MESSAGE_EVENTS = 200;

type MessageRow = {
    id: number;
    role: string;
    created_at?: string;
};

type MessageEnvelope = {
    ok?: boolean;
    data?: MessageRow | null;
};

async function fetchLatestAssistantMessage(port: number): Promise<MessageRow | null> {
    const response = await fetch(`/i/${port}/api/messages/latest`);
    if (!response.ok) return null;
    const body = await response.json() as MessageEnvelope;
    const row = body.data;
    return row && row.role === 'assistant' && Number.isInteger(row.id) ? row : null;
}

export function useInstanceMessageEvents(instances: DashboardInstance[]): ManagerEvent[] {
    const [events, setEvents] = useState<ManagerEvent[]>([]);
    const baselineByPortRef = useRef<Record<number, number>>({});
    const onlinePorts = useMemo(() => {
        return instances.filter(instance => instance.ok).map(instance => instance.port).sort((a, b) => a - b);
    }, [instances]);
    const onlinePortKey = onlinePorts.join(',');

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;

        async function poll(): Promise<void> {
            if (cancelled || onlinePorts.length === 0) return;
            const results = await Promise.allSettled(onlinePorts.map(async (port) => {
                const latest = await fetchLatestAssistantMessage(port);
                return { port, latest };
            }));
            const nextEvents: ManagerEvent[] = [];
            for (const result of results) {
                if (result.status !== 'fulfilled' || !result.value.latest) continue;
                const { port, latest } = result.value;
                const previousId = baselineByPortRef.current[port];
                baselineByPortRef.current[port] = latest.id;
                if (previousId == null || latest.id <= previousId) continue;
                nextEvents.push({
                    kind: 'instance-message',
                    port,
                    messageId: latest.id,
                    role: latest.role,
                    at: latest.created_at && !Number.isNaN(Date.parse(latest.created_at))
                        ? latest.created_at
                        : new Date().toISOString(),
                });
            }
            if (cancelled || nextEvents.length === 0) return;
            setEvents(prev => {
                const merged = [...prev, ...nextEvents];
                if (merged.length > MAX_MESSAGE_EVENTS) merged.splice(0, merged.length - MAX_MESSAGE_EVENTS);
                return merged;
            });
        }

        function start(): void {
            if (timer) return;
            timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
        }

        function stop(): void {
            if (timer) clearInterval(timer);
            timer = null;
        }

        function onVisibilityChange(): void {
            if (document.visibilityState === 'visible') {
                void poll();
                start();
            } else {
                stop();
            }
        }

        void poll();
        start();
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            cancelled = true;
            stop();
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [onlinePortKey]);

    return events;
}
