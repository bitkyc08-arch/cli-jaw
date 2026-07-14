import { useEffect, useRef } from 'react';

type NoteWsEvent = { type: 'file-changed'; path: string } | { type: 'tree-changed' };

type UseNoteSyncOptions = {
    active: boolean;
    onFileChanged?: (path: string) => void;
    onTreeChanged?: () => void;
};

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;

export function useNoteSync(options: UseNoteSyncOptions): void {
    const callbacksRef = useRef(options);
    callbacksRef.current = options;

    useEffect(() => {
        if (!options.active) return;
        let ws: WebSocket | null = null;
        let reconnectDelay = RECONNECT_BASE_MS;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;

        function connect(): void {
            if (disposed) return;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/api/dashboard/notes/ws`);
            ws.onopen = () => { reconnectDelay = RECONNECT_BASE_MS; };
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data as string) as NoteWsEvent;
                    if (data.type === 'file-changed') callbacksRef.current.onFileChanged?.(data.path);
                    else if (data.type === 'tree-changed') callbacksRef.current.onTreeChanged?.();
                } catch { /* Ignore malformed messages. */ }
            };
            ws.onclose = () => {
                ws = null;
                if (disposed) return;
                reconnectTimer = setTimeout(() => {
                    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
                    connect();
                }, reconnectDelay);
            };
            ws.onerror = () => { ws?.close(); };
        }

        connect();
        return () => {
            disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            ws?.close();
        };
    }, [options.active]);
}
