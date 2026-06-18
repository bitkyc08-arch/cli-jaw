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

export interface CodeSessionClient {
    listSessions(): Promise<CodeSession[]>;
    listStoredSessions(cwd?: string): Promise<StoredSession[]>;
    loadSession(sessionId: string, cwd: string): Promise<CodeSession>;
    createSession(cwd: string, model?: string): Promise<CodeSession>;
    sendPrompt(sessionId: string, text: string): Promise<{ accepted: boolean; sessionId: string }>;
    cancelPrompt(sessionId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    answerPermission(permissionId: string, optionId: string | null): Promise<void>;
    setSessionConfig(sessionId: string, configId: string, valueId: string): Promise<void>;
    setSessionModel(sessionId: string, modelId: string): Promise<void>;
}

export function createCodeSessionClient(port: number): CodeSessionClient {
    const base = `http://localhost:${port}`;

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
        async setSessionModel(sessionId: string, modelId: string) {
            await request<unknown>('POST', `/api/code/sessions/${sessionId}/model`, { modelId });
        },
    };
}
