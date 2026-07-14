import type { NoteFile, NoteSearchResult, NotesTreeEntry, NotesVaultIndexSnapshot } from './notes-types';

export class NotesApiError extends Error {
    status: number;
    code: string | null;

    constructor(message: string, status: number, code: string | null = null) {
        super(message);
        this.name = 'NotesApiError';
        this.status = status;
        this.code = code;
    }
}

export type SaveNoteRequest = { path: string; content: string; baseRevision?: string };
export type NoteTemplate = { name: string; path: string };
export type NoteTemplateContent = NoteTemplate & { content: string };
export type TrashNoteKind = 'file' | 'folder';
export type TrashNoteResponse = {
    path: string;
    kind: TrashNoteKind;
    deletedTo: 'os-trash' | 'dashboard-trash';
    restoreHint?: string;
};

const NOTES_API = '/api/dashboard/notes';

async function parseNotesResponse<T>(response: Response, fallback: string): Promise<T> {
    const text = await response.text();
    let body: unknown = null;
    if (text.trim()) {
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            throw new NotesApiError(`${fallback}: response was not JSON`, response.status, 'invalid_json');
        }
    }
    if (!response.ok) {
        const error = typeof body === 'object' && body && 'error' in body ? String(body.error) : fallback;
        const code = typeof body === 'object' && body && 'code' in body && typeof body.code === 'string'
            ? body.code
            : null;
        throw new NotesApiError(error || fallback, response.status, code);
    }
    return body as T;
}

async function notesFetch<T>(path: string, fallback: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${NOTES_API}${path}`, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
    });
    return await parseNotesResponse<T>(response, `${fallback}: ${response.status}`);
}

export function fetchNotesInfo(): Promise<{ root: string }> {
    return notesFetch('/info', 'notes info fetch failed');
}

export async function fetchNotesVersion(): Promise<number> {
    const body = await notesFetch<{ version: number }>('/version', 'notes version fetch failed');
    return body.version;
}

export function fetchNotesTree(): Promise<NotesTreeEntry[]> {
    return notesFetch('/tree', 'notes tree fetch failed');
}

export function fetchNotesIndex(): Promise<NotesVaultIndexSnapshot> {
    return notesFetch('/index', 'notes index fetch failed');
}

export function fetchNoteTemplates(): Promise<NoteTemplate[]> {
    return notesFetch('/templates', 'note templates fetch failed');
}

export function fetchNoteTemplate(name: string): Promise<NoteTemplateContent> {
    return notesFetch(`/template?name=${encodeURIComponent(name)}`, 'note template fetch failed');
}

export function searchNotes(
    query: string,
    options: { limit?: number; regex?: boolean; signal?: AbortSignal } = {},
): Promise<NoteSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.regex) params.set('regex', 'true');
    return notesFetch(`/search?${params}`, 'notes search failed', {
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

export function fetchNoteFile(path: string): Promise<NoteFile> {
    return notesFetch(`/file?path=${encodeURIComponent(path)}`, 'note fetch failed');
}

export function createNoteFile(path: string, content = ''): Promise<NoteFile> {
    return notesFetch('/file', 'note create failed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content }),
    });
}

export function saveNoteFile(request: SaveNoteRequest): Promise<NoteFile> {
    return notesFetch('/file', 'note save failed', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
    });
}

export function createNoteFolder(path: string): Promise<{ path: string }> {
    return notesFetch('/folder', 'note folder create failed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
    });
}

export function renameNotePath(from: string, to: string): Promise<{ from: string; to: string }> {
    return notesFetch('/rename', 'note rename failed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to }),
    });
}

export function trashNotePath(path: string, kind: TrashNoteKind = 'file'): Promise<TrashNoteResponse> {
    return notesFetch('/trash', 'note trash failed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, kind }),
    });
}
