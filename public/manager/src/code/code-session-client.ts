export interface CodeSession {
    sessionId: string;
    cwd: string;
    status: 'idle' | 'streaming' | 'closed';
    createdAt: number;
    lastUsedAt: number;
}

export interface CodeSessionClient {
    listSessions(): Promise<CodeSession[]>;
    createSession(cwd: string, model?: string): Promise<CodeSession>;
    sendPrompt(sessionId: string, text: string): Promise<{ accepted: boolean; sessionId: string }>;
    cancelPrompt(sessionId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
}

export function createCodeSessionClient(port: number): CodeSessionClient {
    const base = `http://localhost:${port}`;

    async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || `${method} ${path} failed`);
        return data as T;
    }

    return {
        async listSessions() {
            const data = await request<{ sessions: CodeSession[] }>('GET', '/api/code/sessions');
            return data.sessions;
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
    };
}
