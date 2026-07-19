// Dock-local instance client (070): feature-local HTTP client following the
// repo convention (chat/pending/pending-queue-api.ts). Talks to the selected
// instance through the manager `/i/<port>` proxy. Instance APIs answer either
// `{ok,data}` or bare payloads — unwrapData (dock-settings.ts) handles both.
import { useCallback, useEffect, useMemo, useState } from 'react';

const TIMEOUT_MS = 8000;

export class DockRequestError extends Error {
    method: string;
    path: string;
    status: number;
    detail: string;
    constructor(method: string, path: string, status: number, detail: string) {
        super(`${method} ${path} → ${status}: ${detail}`);
        this.name = 'DockRequestError';
        this.method = method;
        this.path = path;
        this.status = status;
        this.detail = detail;
    }
}

export interface DockClient {
    get<T>(path: string, init?: RequestInit): Promise<T>;
    put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
    post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
    delete<T>(path: string, init?: RequestInit): Promise<T>;
}

export function createDockClient(port: number): DockClient {
    const base = `/i/${port}`;
    const headers: HeadersInit = { 'content-type': 'application/json' };

    async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const fetchInit: RequestInit = { method, headers, signal: init?.signal || controller.signal, ...init };
            if (body !== undefined) fetchInit.body = JSON.stringify(body);
            const response = await fetch(`${base}${path}`, fetchInit);
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new DockRequestError(method, path, response.status, detail);
            }
            const ct = response.headers.get('content-type') || '';
            if (ct.includes('application/json')) return (await response.json()) as T;
            const detail = await response.text().catch(() => '');
            throw new DockRequestError(method, path, response.status, `expected JSON: ${detail.slice(0, 120)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        get: (path, init) => request('GET', path, undefined, init),
        put: (path, body, init) => request('PUT', path, body, init),
        post: (path, body, init) => request('POST', path, body, init),
        delete: (path, init) => request('DELETE', path, undefined, init),
    };
}

export function useDockClient(port: number): DockClient {
    return useMemo(() => createDockClient(port), [port]);
}

// ── Snapshot hook (manager page-shell usePageSnapshot parity, dock-local) ──

export type DockSnapshotState<T> =
    | { kind: 'loading' }
    | { kind: 'ready'; data: T }
    | { kind: 'offline' }
    | { kind: 'error'; message: string };

export function useDockSnapshot<T>(
    client: DockClient,
    path: string,
    deps: ReadonlyArray<unknown> = [],
): {
    state: DockSnapshotState<T>;
    refresh: () => Promise<void>;
    setData: (next: T) => void;
} {
    const [state, setState] = useState<DockSnapshotState<T>>({ kind: 'loading' });
    const [reloadTick, setReloadTick] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setState({ kind: 'loading' });
        client.get<T>(path)
            .then((data) => { if (!cancelled) setState({ kind: 'ready', data }); })
            .catch((err: unknown) => {
                if (cancelled) return;
                if (err instanceof DockRequestError && (err.status >= 500 || err.status === 0)) {
                    setState({ kind: 'offline' });
                } else {
                    setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
                }
            });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, path, reloadTick, ...deps]);

    const refresh = useCallback(async () => { setReloadTick((tick) => tick + 1); }, []);
    const setData = useCallback((next: T) => { setState({ kind: 'ready', data: next }); }, []);
    return { state, refresh, setData };
}
