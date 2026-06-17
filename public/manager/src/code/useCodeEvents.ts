import { useEffect, useRef, useCallback } from 'react';

export type CodeEvent = {
    topic: string;
    event: string;
    sessionId?: string;
    update?: Record<string, unknown>;
    stopReason?: string;
    reason?: string;
    [key: string]: unknown;
};

type UseCodeEventsOptions = {
    port: number;
    sessionId: string | null;
    onEvent: (event: CodeEvent) => void;
};

export function useCodeEvents({ port, sessionId, onEvent }: UseCodeEventsOptions): void {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;

    const connect = useCallback(() => {
        const es = new EventSource(`http://localhost:${port}/api/events`);
        es.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data) as CodeEvent;
                if (data.topic !== 'jwc') return;
                if (!sessionId) return;
                if (data.sessionId && data.sessionId !== sessionId) return;
                onEventRef.current(data);
            } catch { /* ignore parse errors */ }
        };
        return es;
    }, [port, sessionId]);

    useEffect(() => {
        const es = connect();
        return () => es.close();
    }, [connect]);
}
