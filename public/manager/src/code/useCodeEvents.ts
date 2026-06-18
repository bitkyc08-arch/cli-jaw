import { useEffect, useRef } from 'react';

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

function createEventsUrl(port: number): string {
    if (typeof window !== 'undefined' && window.location.port === String(port)) {
        return `${window.location.origin}/api/events`;
    }
    return `http://127.0.0.1:${port}/api/events`;
}

export function useCodeEvents({ port, sessionId, onEvent }: UseCodeEventsOptions): void {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const sessionIdRef = useRef(sessionId);
    sessionIdRef.current = sessionId;

    useEffect(() => {
        if (!port) return;
        const es = new EventSource(createEventsUrl(port));
        es.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data) as CodeEvent;
                if (data.topic !== 'jwc') return;
                const sid = sessionIdRef.current;
                if (!sid) return;
                if (data.sessionId && data.sessionId !== sid) return;
                onEventRef.current(data);
            } catch { /* ignore parse errors */ }
        };
        es.onerror = () => {
            // Native EventSource auto-reconnects on network errors.
            // Explicit handler prevents unhandled error noise in console.
        };
        return () => es.close();
    }, [port]);
}
