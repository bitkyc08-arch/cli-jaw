import type {
    CodeSessionInfo,
    StoredCodeSessionInfo,
} from '../../../../src/code-mode/types.ts';

interface SessionsResponse {
    ok: true;
    sessions: CodeSessionInfo[];
}

interface StoredSessionsResponse {
    ok: true;
    sessions: StoredCodeSessionInfo[];
}

interface SessionResponse {
    ok: true;
    session: CodeSessionInfo;
}

interface PromptResponse {
    ok: true;
    accepted: true;
    sessionId: string;
}

interface PermissionsResponse {
    ok: true;
    permissions: unknown[];
}

interface OkResponse {
    ok: true;
}

export interface CodeApiClient {
    listSessions(): Promise<CodeSessionInfo[]>;
    listStoredSessions(scope?: 'all' | 'cwd'): Promise<StoredCodeSessionInfo[]>;
    loadSession(sessionId: string, cwd?: string): Promise<CodeSessionInfo>;
    newSession(cwd?: string): Promise<CodeSessionInfo>;
    prompt(sessionId: string, text: string): Promise<PromptResponse>;
    cancel(sessionId: string): Promise<OkResponse>;
    listPermissions(): Promise<unknown[]>;
    answerPermission(id: string, optionId: string): Promise<OkResponse>;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
}

export function createCodeApiClient(port: number): CodeApiClient {
    const base = `/i/${port}/api/code`;
    const post = <T>(path: string, body?: unknown): Promise<T> => fetchJson<T>(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });

    return {
        async listSessions() {
            const response = await fetchJson<SessionsResponse>(`${base}/sessions`);
            return response.sessions;
        },
        async listStoredSessions(scope) {
            const params = new URLSearchParams();
            if (scope !== undefined) params.set('scope', scope);
            const query = params.size ? `?${params.toString()}` : '';
            const response = await fetchJson<StoredSessionsResponse>(`${base}/sessions/stored${query}`);
            return response.sessions;
        },
        async loadSession(sessionId, cwd) {
            const response = await post<SessionResponse>('/sessions/load', { sessionId, cwd });
            return response.session;
        },
        async newSession(cwd) {
            const response = await post<SessionResponse>('/sessions', { cwd });
            return response.session;
        },
        prompt(sessionId, text) {
            return post<PromptResponse>(`/sessions/${encodeURIComponent(sessionId)}/prompt`, { text });
        },
        cancel(sessionId) {
            return post<OkResponse>(`/sessions/${encodeURIComponent(sessionId)}/cancel`);
        },
        async listPermissions() {
            const response = await fetchJson<PermissionsResponse>(`${base}/permissions`);
            return response.permissions;
        },
        answerPermission(id, optionId) {
            return post<OkResponse>(`/permissions/${encodeURIComponent(id)}`, { optionId });
        },
    };
}
