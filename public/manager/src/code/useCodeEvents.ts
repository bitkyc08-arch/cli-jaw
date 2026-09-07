import { useEffect, useRef } from 'react';
import type { CodeWireEvent } from '../../../../src/code-mode/wire';
import type { CodeTransportState } from './code-controller-types';
import { codeBaseOrigin } from './code-session-client';

export type CodeEvent = CodeWireEvent;
export type { CodeTransportState } from './code-controller-types';

type UseCodeEventsOptions = {
    port: number;
    onEvent: (event: CodeWireEvent) => void;
    onTransport?: (state: CodeTransportState) => void;
};

export function useCodeEvents({ port, onEvent, onTransport }: UseCodeEventsOptions): void {
    const callbacks = useRef({ onEvent, onTransport });
    callbacks.current = { onEvent, onTransport };
    useEffect(() => {
        if (!port) return;
        let active = true;
        // Preserve the Manager's same-origin cookie / loopback instance auth path.
        const es = new EventSource(`${codeBaseOrigin(port)}/api/events`);
        es.onopen = () => { if (active) callbacks.current.onTransport?.('connected'); };
        es.onmessage = msg => {
            if (!active) return;
            let data: CodeWireEvent;
            try { data = JSON.parse(msg.data); } catch { return; }
            if (data?.topic !== 'code' || typeof data.sessionId !== 'string'
                || !Number.isSafeInteger(data.sequence) || data.sequence < 1
                || !Number.isSafeInteger(data.epoch)) return;
            if (data.event !== 'code_item' && data.event !== 'code_item_update' && data.event !== 'code_session') return;
            callbacks.current.onEvent(data);
        };
        es.onerror = () => {
            if (active) callbacks.current.onTransport?.(es.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting');
        };
        return () => { active = false; es.close(); };
    }, [port]);
}
