import type {
    DashboardInstance,
    DashboardInstanceMessageResult,
    DashboardLifecycleAction,
    DashboardLifecycleResult,
    DashboardNoteAssetResponse,
    DashboardNoteFileResponse,
    DashboardNoteSearchResult,
    DashboardNotesCapabilities,
    DashboardNoteTreeEntry,
    DashboardPutNoteRequest,
    DashboardProcessControlState,
    DashboardRegistryLoadResult,
    DashboardRegistryPatch,
    DashboardScanResult,
    DashboardTrashNoteKind,
    DashboardTrashNoteResponse,
    HealthEvent,
    InstanceLogSnapshot,
    ManagerEvent,
    VaultIndexSnapshot,
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

export async function fetchInstances(showHidden = false, options: { fresh?: boolean } = {}): Promise<DashboardScanResult> {
    const params = new URLSearchParams();
    if (showHidden) params.set('showHidden', '1');
    if (options.fresh) params.set('fresh', '1');
    const query = params.toString();
    const path = query ? `/api/dashboard/instances?${query}` : '/api/dashboard/instances';
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
    const init: RequestInit = {};
    if (options.signal !== undefined) init.signal = options.signal;
    const response = await fetch(`/api/dashboard/instances/${port}`, init);
    if (!response.ok) throw new Error(`status fetch failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; instance: DashboardInstance | null };
    return body.instance;
}

/** #233 follow-up: open the worker's native folder chooser and apply the
 *  picked folder as that instance's project root. Resolves when the user
 *  answers the dialog (can take minutes). */
export async function pickInstanceProjectFolder(port: number): Promise<{ projectDirs?: string[] | null; cancelled?: boolean }> {
    const response = await fetch(`/api/dashboard/instances/${port}/project/pick`, { method: 'POST' });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; data?: { projectDirs?: string[] | null; cancelled?: boolean }; error?: string; projectDirs?: string[] | null; cancelled?: boolean };
    if (!response.ok) throw new Error(body.error || `project pick failed: ${response.status}`);
    return body.data ?? body;
}

export async function sendInstanceMessage(
    port: number,
    prompt: string,
    sessionId?: string,
): Promise<{ ok: boolean; status: number; data: DashboardInstanceMessageResult }> {
    const response = await fetch(`/api/dashboard/instances/${port}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionId ? { prompt, sessionId } : { prompt }),
    });
    const data = await response.json().catch(() => ({})) as DashboardInstanceMessageResult;
    return { ok: response.ok, status: response.status, data };
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

export async function fetchNotesInfo(): Promise<{ root: string }> {
    const response = await fetch('/api/dashboard/notes/info');
    return await parseNotesResponse<{ root: string }>(response, `notes info fetch failed: ${response.status}`);
}

export async function fetchNotesVersion(): Promise<number> {
    const response = await fetch('/api/dashboard/notes/version');
    const body = await parseNotesResponse<{ version: number }>(response, `notes version fetch failed: ${response.status}`);
    return body.version;
}

export async function fetchNotesTree(): Promise<DashboardNoteTreeEntry[]> {
    const response = await fetch('/api/dashboard/notes/tree');
    return await parseNotesResponse<DashboardNoteTreeEntry[]>(response, `notes tree fetch failed: ${response.status}`);
}

export type NoteTemplate = { name: string; path: string };
export type NoteTemplateContent = { name: string; path: string; content: string };

export async function fetchNoteTemplates(): Promise<NoteTemplate[]> {
    const response = await fetch('/api/dashboard/notes/templates');
    return await parseNotesResponse<NoteTemplate[]>(response, `note templates fetch failed: ${response.status}`);
}

export async function fetchNoteTemplate(name: string): Promise<NoteTemplateContent> {
    const response = await fetch(`/api/dashboard/notes/template?name=${encodeURIComponent(name)}`);
    return await parseNotesResponse<NoteTemplateContent>(response, `note template fetch failed: ${response.status}`);
}

export type NoteSnippetInfo = { name: string; file: string; enabled: boolean };
export type NoteSnippetsResponse = { snippets: NoteSnippetInfo[]; activeTheme: string | null };

export async function fetchNoteSnippets(): Promise<NoteSnippetsResponse> {
    const response = await fetch('/api/dashboard/notes/snippets');
    return await parseNotesResponse<NoteSnippetsResponse>(response, `note snippets fetch failed: ${response.status}`);
}

export async function fetchNoteSnippetCss(name: string): Promise<string> {
    const response = await fetch(`/api/dashboard/notes/snippets/file?name=${encodeURIComponent(name)}`);
    if (!response.ok) throw new DashboardApiError(`snippet fetch failed: ${response.status}`, response.status);
    return await response.text();
}

export async function toggleNoteSnippet(name: string, enabled: boolean): Promise<void> {
    const response = await fetch('/api/dashboard/notes/snippets/toggle', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled }),
    });
    if (!response.ok) throw new DashboardApiError(`snippet toggle failed: ${response.status}`, response.status);
}

export async function setNoteTheme(theme: string | null): Promise<void> {
    const response = await fetch('/api/dashboard/notes/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
    });
    if (!response.ok) throw new DashboardApiError(`theme set failed: ${response.status}`, response.status);
}

export async function fetchNotesIndex(): Promise<VaultIndexSnapshot> {
    const response = await fetch('/api/dashboard/notes/index');
    return await parseNotesResponse<VaultIndexSnapshot>(response, `notes index fetch failed: ${response.status}`);
}

export async function fetchNotesCapabilities(): Promise<DashboardNotesCapabilities> {
    const response = await fetch('/api/dashboard/notes/capabilities');
    return await parseNotesResponse<DashboardNotesCapabilities>(response, `notes capabilities fetch failed: ${response.status}`);
}

export async function searchNotes(
    query: string,
    options: { limit?: number; regex?: boolean; signal?: AbortSignal } = {},
): Promise<DashboardNoteSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.regex) params.set('regex', 'true');
    const init: RequestInit = {};
    if (options.signal) init.signal = options.signal;
    const response = await fetch(`/api/dashboard/notes/search?${params}`, init);
    return await parseNotesResponse<DashboardNoteSearchResult[]>(
        response,
        `notes search failed: ${response.status}`,
    );
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

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export async function uploadNoteAsset(notePath: string, file: File): Promise<DashboardNoteAssetResponse> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const response = await fetch('/api/dashboard/notes/asset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            notePath,
            mime: file.type,
            dataBase64: bytesToBase64(bytes),
        }),
    });
    return await parseNotesResponse<DashboardNoteAssetResponse>(response, `note asset upload failed: ${response.status}`);
}

export async function uploadRemoteNoteAsset(notePath: string, url: string): Promise<DashboardNoteAssetResponse> {
    const response = await fetch('/api/dashboard/notes/asset/remote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notePath, url }),
    });
    return await parseNotesResponse<DashboardNoteAssetResponse>(response, `remote note asset upload failed: ${response.status}`);
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

export async function trashNotePath(
    path: string,
    kind: DashboardTrashNoteKind = 'file',
): Promise<DashboardTrashNoteResponse> {
    const response = await fetch('/api/dashboard/notes/trash', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, kind }),
    });
    return await parseNotesResponse<DashboardTrashNoteResponse>(response, `note trash failed: ${response.status}`);
}
