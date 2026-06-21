import { useEffect, useRef, type MutableRefObject } from 'react';

export type CodeEvent = {
    topic: string;
    event: string;
    sseEventId?: string;
    sessionId?: string;
    update?: Record<string, unknown>;
    stopReason?: string;
    reason?: string;
    [key: string]: unknown;
};

export type CodeTransportState = 'connected' | 'reconnecting' | 'disconnected';

type UseCodeEventsOptions = {
    port: number;
    sessionId: string | null;
    sessionIdRef?: MutableRefObject<string | null>;
    onEvent: (event: CodeEvent) => void;
    onTransport?: (state: CodeTransportState) => void;
};

function createEventsUrl(port: number): string {
    if (typeof window !== 'undefined' && window.location.port === String(port)) {
        return `${window.location.origin}/api/events`;
    }
    return `http://127.0.0.1:${port}/api/events`;
}

export function useCodeEvents({ port, sessionId, sessionIdRef: externalSessionIdRef, onEvent, onTransport }: UseCodeEventsOptions): void {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const onTransportRef = useRef(onTransport);
    onTransportRef.current = onTransport;
    const sessionIdRef = useRef(sessionId);
    sessionIdRef.current = sessionId;

    useEffect(() => {
        if (!port) return;
        const es = new EventSource(createEventsUrl(port));
        es.onopen = () => {
            // Slice 216: surface live transport state (connected / recovered after a drop).
            onTransportRef.current?.('connected');
        };
        es.onmessage = (msg) => {
            try {
                const data = { ...JSON.parse(msg.data), sseEventId: msg.lastEventId || undefined } as CodeEvent;
                if (data.topic !== 'jwc') return;
                const isGlobalCodeEvent = data.event === 'code_child_exit';
                const sid = externalSessionIdRef?.current ?? sessionIdRef.current;
                if (!sid && !isGlobalCodeEvent) return;
                if (!isGlobalCodeEvent && data.sessionId && data.sessionId !== sid) return;
                onEventRef.current(data);
            } catch { /* ignore parse errors */ }
        };
        es.onerror = () => {
            // Native EventSource auto-reconnects on network errors. Surface the state
            // so the UI can show a non-intrusive reconnecting/disconnected indicator.
            onTransportRef.current?.(es.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting');
        };
        return () => es.close();
    }, [port]);
}
