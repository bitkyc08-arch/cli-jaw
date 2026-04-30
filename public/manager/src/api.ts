import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardLifecycleResult,
    DashboardNoteFileResponse,
    DashboardNoteTreeEntry,
    DashboardPutNoteRequest,
    DashboardProcessControlState,
    DashboardRegistryLoadResult,
    DashboardRegistryPatch,
    DashboardScanResult,
    DashboardTrashNoteResponse,
    HealthEvent,
    InstanceLogSnapshot,
    ManagerEvent,
} from './types';

export class DashboardApiError extends Error {
    status: number;
    code: string | null;

    constructor(message: string, status: number, code: string | null = null) {
        super(message);
        this.name = 'DashboardApiError';
        this.status = status;
        this.code = code;
    }
}

export async function fetchInstances(showHidden = false): Promise<DashboardScanResult> {
    const path = showHidden ? '/api/dashboard/instances?showHidden=1' : '/api/dashboard/instances';
    const response = await fetch(path);
    if (!response.ok) throw new Error(`scan failed: ${response.status}`);
    return await response.json() as DashboardScanResult;
}

export async function fetchRegistry(): Promise<DashboardRegistryLoadResult> {
    const response = await fetch('/api/dashboard/registry');
    if (!response.ok) throw new Error(`registry load failed: ${response.status}`);
    return await response.json() as DashboardRegistryLoadResult;
}

export async function patchDashboardRegistry(patch: DashboardRegistryPatch): Promise<DashboardRegistryLoadResult> {
    const response = await fetch('/api/dashboard/registry', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(`registry save failed: ${response.status}`);
    return await response.json() as DashboardRegistryLoadResult;
}

export async function runLifecycleAction(
    action: DashboardLifecycleAction,
    port: number,
    home?: string,
): Promise<DashboardLifecycleResult> {
    const response = await fetch(`/api/dashboard/lifecycle/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port, ...(home?.trim() ? { home: home.trim() } : {}) }),
    });
    const result = await response.json() as DashboardLifecycleResult;
    if (!response.ok || !result.ok) {
        throw new Error(result.message || `${action} failed: ${response.status}`);
    }
    return result;
}

export async function fetchProcessControlState(): Promise<DashboardProcessControlState> {
    const response = await fetch('/api/dashboard/process-control');
    if (!response.ok) throw new Error(`process control fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; state: DashboardProcessControlState };
    return body.state;
}

export async function adoptManagedProcesses(): Promise<DashboardProcessControlState> {
    const response = await fetch('/api/dashboard/process-control/adopt', { method: 'POST' });
    if (!response.ok) throw new Error(`adopt managed failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; state: DashboardProcessControlState };
    return body.state;
}

export async function stopManagedProcesses(): Promise<DashboardProcessControlState> {
    const response = await fetch('/api/dashboard/process-control/stop-managed', { method: 'POST' });
    if (!response.ok) throw new Error(`stop managed failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; state: DashboardProcessControlState };
    return body.state;
}

export async function fetchInstanceStatus(port: number, options: { signal?: AbortSignal } = {}): Promise<DashboardInstance | null> {
    const response = await fetch(`/api/dashboard/instances/${port}`, { signal: options.signal });
    if (!response.ok) throw new Error(`status fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; instance: DashboardInstance | null };
    return body.instance;
}

export async function fetchManagerEvents(since: string | null = null): Promise<ManagerEvent[]> {
    const path = since ? `/api/manager/events?since=${encodeURIComponent(since)}` : '/api/manager/events';
    const response = await fetch(path);
    if (!response.ok) throw new Error(`events fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; events: ManagerEvent[] };
    return body.events;
}

export async function fetchHealthHistory(port: number, limit?: number): Promise<HealthEvent[]> {
    const path = limit ? `/api/manager/health-history/${port}?limit=${limit}` : `/api/manager/health-history/${port}`;
    const response = await fetch(path);
    if (!response.ok) throw new Error(`health history fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; events: HealthEvent[] };
    return body.events;
}

export async function fetchInstanceLogSnapshot(port: number): Promise<InstanceLogSnapshot> {
    const response = await fetch(`/api/manager/instance-logs/${port}`);
    if (!response.ok) throw new Error(`logs fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; snapshot: InstanceLogSnapshot };
    return body.snapshot;
}

async function parseNotesResponse<T>(response: Response, fallback: string): Promise<T> {
    const text = await response.text();
    let body: unknown = null;
    if (text.trim()) {
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            throw new DashboardApiError(`${fallback}: response was not JSON`, response.status, 'invalid_json');
        }
    }
    if (!response.ok) {
        const error = typeof body === 'object' && body && 'error' in body
            ? String(body.error)
            : fallback;
        const code = typeof body === 'object' && body && 'code' in body && typeof body.code === 'string'
            ? body.code
            : null;
        throw new DashboardApiError(error || fallback, response.status, code);
    }
    return body as T;
}

export async function fetchNotesTree(): Promise<DashboardNoteTreeEntry[]> {
    const response = await fetch('/api/dashboard/notes/tree');
    return await parseNotesResponse<DashboardNoteTreeEntry[]>(response, `notes tree fetch failed: ${response.status}`);
}

export async function fetchNoteFile(path: string): Promise<DashboardNoteFileResponse> {
    const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(path)}`);
    return await parseNotesResponse<DashboardNoteFileResponse>(response, `note fetch failed: ${response.status}`);
}

export async function createNoteFile(path: string, content = ''): Promise<DashboardNoteFileResponse> {
    const response = await fetch('/api/dashboard/notes/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content }),
    });
    return await parseNotesResponse<DashboardNoteFileResponse>(response, `note create failed: ${response.status}`);
}

export async function saveNoteFile(request: DashboardPutNoteRequest): Promise<DashboardNoteFileResponse> {
    const response = await fetch('/api/dashboard/notes/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
    });
    return await parseNotesResponse<DashboardNoteFileResponse>(response, `note save failed: ${response.status}`);
}

export async function createNoteFolder(path: string): Promise<{ path: string }> {
    const response = await fetch('/api/dashboard/notes/folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    return await parseNotesResponse<{ path: string }>(response, `note folder create failed: ${response.status}`);
}

export async function renameNotePath(from: string, to: string): Promise<{ from: string; to: string }> {
    const response = await fetch('/api/dashboard/notes/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to }),
    });
    return await parseNotesResponse<{ from: string; to: string }>(response, `note rename failed: ${response.status}`);
}

export async function trashNotePath(path: string): Promise<DashboardTrashNoteResponse> {
    const response = await fetch('/api/dashboard/notes/trash', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    return await parseNotesResponse<DashboardTrashNoteResponse>(response, `note trash failed: ${response.status}`);
}
