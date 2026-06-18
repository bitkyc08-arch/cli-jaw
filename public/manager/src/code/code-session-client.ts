export interface CodeSession {
    sessionId: string;
    cwd: string;
    status: 'starting' | 'idle' | 'streaming' | 'closed';
    createdAt: number;
    lastUsedAt: number;
}

export interface StoredSession {
    sessionId: string;
    cwd: string;
    title?: string;
    lastModified?: number;
}

export interface CodeModelProvider {
    id: string;
    models: string[];
    efforts: string[];
}

export interface CodeModelOptions {
    providers: CodeModelProvider[];
    defaultProvider: string;
    defaultModel: string;
    degraded?: boolean;
    error?: string;
}

export interface CodeGitInfo {
    isRepo: boolean;
    branch: string | null;
    head?: string | null;
    status?: {
        dirty: boolean;
        changed: number;
        untracked: number;
    };
    worktrees: Array<{
        path: string;
        branch: string | null;
        head?: string | null;
        current?: boolean;
    }>;
}

export interface CodeSessionClient {
    listSessions(): Promise<CodeSession[]>;
    listStoredSessions(cwd?: string): Promise<StoredSession[]>;
    listModelOptions(): Promise<CodeModelOptions>;
    getGitInfo(cwd: string): Promise<CodeGitInfo>;
    loadSession(sessionId: string, cwd: string): Promise<CodeSession>;
    createSession(cwd: string, model?: string): Promise<CodeSession>;
    sendPrompt(sessionId: string, text: string): Promise<{ accepted: boolean; sessionId: string }>;
    cancelPrompt(sessionId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    answerPermission(permissionId: string, optionId: string | null): Promise<void>;
    setSessionConfig(sessionId: string, configId: string, valueId: string): Promise<void>;
    extMethod(sessionId: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    forkSession(sessionId: string, cwd: string): Promise<CodeSession>;
    setSessionModel(sessionId: string, modelId: string): Promise<void>;
}

export function createCodeSessionClient(port: number): CodeSessionClient {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const currentPort = typeof window !== 'undefined' ? window.location.port : '';
    const base = origin && currentPort === String(port) ? origin : `http://127.0.0.1:${port}`;

    async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const opts: RequestInit = { method };
        if (body) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(`${base}${path}`, opts);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || `${method} ${path} failed`);
        return data as T;
    }

    return {
        async listSessions() {
            const data = await request<{ sessions: CodeSession[] }>('GET', '/api/code/sessions');
            return data.sessions;
        },
        async listStoredSessions(cwd?: string) {
            const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
            const data = await request<{ sessions: StoredSession[] }>('GET', `/api/code/sessions/stored${qs}`);
            return data.sessions;
        },
        async listModelOptions() {
            return request<CodeModelOptions>('GET', '/api/code/models');
        },
        async getGitInfo(cwd: string) {
            const data = await request<CodeGitInfo>('GET', `/api/code/git-info?cwd=${encodeURIComponent(cwd)}`);
            return data;
        },
        async loadSession(sessionId: string, cwd: string) {
            const data = await request<{ session: CodeSession }>('POST', '/api/code/sessions/load', { sessionId, cwd });
            return data.session;
        },
        async createSession(cwd: string, model?: string) {
            const data = await request<{ session: CodeSession }>('POST', '/api/code/sessions', {
                cwd,
                ...(model ? { model } : {}),
            });
            return data.session;
        },
        async sendPrompt(sessionId: string, text: string) {
            return request<{ accepted: boolean; sessionId: string }>('POST', `/api/code/sessions/${sessionId}/prompt`, { text });
        },
        async cancelPrompt(sessionId: string) {
            await request<unknown>('POST', `/api/code/sessions/${sessionId}/cancel`);
        },
        async closeSession(sessionId: string) {
            await request<unknown>('DELETE', `/api/code/sessions/${sessionId}`);
        },
        async answerPermission(permissionId: string, optionId: string | null) {
            await request<unknown>('POST', `/api/code/permissions/${permissionId}`, { optionId });
        },
        async setSessionConfig(sessionId: string, configId: string, valueId: string) {
            await request<unknown>('POST', `/api/code/sessions/${sessionId}/config`, { configId, valueId });
        },
        async extMethod(sessionId: string, method: string, params?: Record<string, unknown>) {
            const data = await request<{ result: Record<string, unknown> }>('POST', `/api/code/sessions/${sessionId}/ext`, { method, params });
            return data.result;
        },
        async forkSession(sessionId: string, cwd: string) {
            const data = await request<{ session: CodeSession }>('POST', `/api/code/sessions/${sessionId}/fork`, { cwd });
            return data.session;
        },
        async setSessionModel(sessionId: string, modelId: string) {
            await request<unknown>('POST', `/api/code/sessions/${sessionId}/model`, { modelId });
        },
    };
}
