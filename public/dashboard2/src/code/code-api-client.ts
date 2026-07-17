import type {
    CodeSessionInfo,
    StoredCodeSessionInfo,
} from '../../../../src/code-mode/types.ts';

export type CodeApiErrorCode =
    | 'request_failed'
    | 'http_error'
    | 'invalid_content_type'
    | 'invalid_json'
    | 'invalid_response';

export class CodeApiError extends Error {
    readonly code: CodeApiErrorCode;
    readonly status: number | null;

    constructor(code: CodeApiErrorCode, message: string, status: number | null = null) {
        super(message);
        this.name = 'CodeApiError';
        this.code = code;
        this.status = status;
    }
}

export interface CodeModelProvider {
    id: string;
    models: string[];
    efforts: string[];
    modelSource?: 'jwc-cache' | 'static-fallback';
}

export interface CodeModelOptions {
    providers: CodeModelProvider[];
    defaultProvider: string;
    defaultModel: string;
    usageOrder?: string[];
    degraded?: boolean;
}

interface PromptResponse {
    ok: true;
    accepted: true;
    sessionId: string;
}

interface OkResponse {
    ok: true;
}

export interface CodeRequestOptions {
    signal?: AbortSignal;
}

export interface CodeApiClientOptions {
    fetchImpl?: typeof fetch;
}

export interface CodeApiClient {
    listSessions(options?: CodeRequestOptions): Promise<CodeSessionInfo[]>;
    listStoredSessions(scope?: 'all' | 'cwd', options?: CodeRequestOptions): Promise<StoredCodeSessionInfo[]>;
    listModelOptions(options?: CodeRequestOptions): Promise<CodeModelOptions>;
    loadSession(sessionId: string, cwd?: string, options?: CodeRequestOptions): Promise<CodeSessionInfo>;
    newSession(cwd?: string, model?: string, options?: CodeRequestOptions): Promise<CodeSessionInfo>;
    setSessionModel(sessionId: string, modelId: string, options?: CodeRequestOptions): Promise<CodeSessionInfo>;
    closeSession(sessionId: string, options?: CodeRequestOptions): Promise<OkResponse>;
    prompt(sessionId: string, text: string, options?: CodeRequestOptions): Promise<PromptResponse>;
    cancel(sessionId: string, options?: CodeRequestOptions): Promise<OkResponse>;
    listPermissions(options?: CodeRequestOptions): Promise<unknown[]>;
    answerPermission(id: string, optionId: string, options?: CodeRequestOptions): Promise<OkResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function decodeCodeSessionValue(value: unknown, kind: string): CodeSessionInfo {
    if (!isRecord(value)
        || typeof value['sessionId'] !== 'string'
        || typeof value['cwd'] !== 'string'
        || !['starting', 'idle', 'streaming', 'closed'].includes(String(value['status']))
        || !isFiniteNumber(value['createdAt'])
        || !isFiniteNumber(value['lastUsedAt'])
        || (value['modelId'] !== null && typeof value['modelId'] !== 'string')
        || ('title' in value && typeof value['title'] !== 'string')) throw invalidResponse(kind);
    let replayEvents: CodeSessionInfo['replayEvents'];
    if ('replayEvents' in value) {
        if (!Array.isArray(value['replayEvents']) || !value['replayEvents'].every(event => (
            isRecord(event)
            && typeof event['event'] === 'string'
            && typeof event['sessionId'] === 'string'
            && isRecord(event['update'])
        ))) throw invalidResponse(kind);
        replayEvents = value['replayEvents'].map(event => ({
            event: event['event'] as string,
            sessionId: event['sessionId'] as string,
            update: { ...(event['update'] as Record<string, unknown>) },
        }));
    }
    return {
        sessionId: value['sessionId'],
        cwd: value['cwd'],
        status: value['status'] as CodeSessionInfo['status'],
        createdAt: value['createdAt'],
        lastUsedAt: value['lastUsedAt'],
        modelId: value['modelId'] as string | null,
        ...(typeof value['title'] === 'string' ? { title: value['title'] } : {}),
        ...(replayEvents ? { replayEvents } : {}),
    };
}

function decodeStoredSessionValue(value: unknown): StoredCodeSessionInfo {
    if (!isRecord(value) || typeof value['sessionId'] !== 'string' || typeof value['cwd'] !== 'string') {
        throw invalidResponse('Stored Code sessions');
    }
    const optionalStrings = ['title', 'firstMessage', 'updatedAt'] as const;
    const optionalNumbers = ['lastModified', 'messageCount', 'size'] as const;
    if (!optionalStrings.every(key => !(key in value) || typeof value[key] === 'string')
        || !optionalNumbers.every(key => !(key in value) || isFiniteNumber(value[key]))) {
        throw invalidResponse('Stored Code sessions');
    }
    return {
        sessionId: value['sessionId'], cwd: value['cwd'],
        ...Object.fromEntries(optionalStrings.flatMap(key => typeof value[key] === 'string' ? [[key, value[key]]] : [])),
        ...Object.fromEntries(optionalNumbers.flatMap(key => isFiniteNumber(value[key]) ? [[key, value[key]]] : [])),
    } as StoredCodeSessionInfo;
}

function invalidResponse(kind: string): CodeApiError {
    return new CodeApiError('invalid_response', `${kind} returned an invalid response`);
}

function decodeSessions(value: unknown): CodeSessionInfo[] {
    if (!isRecord(value) || value['ok'] !== true || !Array.isArray(value['sessions'])) {
        throw invalidResponse('Code sessions');
    }
    return value['sessions'].map(session => decodeCodeSessionValue(session, 'Code sessions'));
}

function decodeStoredSessions(value: unknown): StoredCodeSessionInfo[] {
    if (!isRecord(value) || value['ok'] !== true || !Array.isArray(value['sessions'])) {
        throw invalidResponse('Stored Code sessions');
    }
    return value['sessions'].map(decodeStoredSessionValue);
}

function decodeSession(value: unknown): CodeSessionInfo {
    if (!isRecord(value) || value['ok'] !== true) {
        throw invalidResponse('Code session');
    }
    return decodeCodeSessionValue(value['session'], 'Code session');
}

export function decodeCodeModelOptions(value: unknown): CodeModelOptions {
    if (!isRecord(value)
        || value['ok'] !== true
        || !Array.isArray(value['providers'])
        || typeof value['defaultProvider'] !== 'string'
        || typeof value['defaultModel'] !== 'string'
        || ('usageOrder' in value && !isStringArray(value['usageOrder']))
        || ('degraded' in value && typeof value['degraded'] !== 'boolean')
        || ('error' in value && typeof value['error'] !== 'string')) {
        throw invalidResponse('Code models');
    }
    const providers: CodeModelProvider[] = [];
    for (const provider of value['providers']) {
        const modelSource = isRecord(provider) ? provider['modelSource'] : undefined;
        if (!isRecord(provider)
            || typeof provider['id'] !== 'string'
            || !provider['id']
            || !isStringArray(provider['models'])
            || !isStringArray(provider['efforts'])
            || ('modelSource' in provider && modelSource !== 'jwc-cache' && modelSource !== 'static-fallback')) {
            throw invalidResponse('Code models');
        }
        providers.push({
            id: provider['id'],
            models: [...provider['models']],
            efforts: [...provider['efforts']],
            ...(modelSource === 'jwc-cache' || modelSource === 'static-fallback' ? { modelSource } : {}),
        });
    }
    const usageOrder = value['usageOrder'];
    const degraded = value['degraded'];
    return {
        providers,
        defaultProvider: value['defaultProvider'],
        defaultModel: value['defaultModel'],
        ...(isStringArray(usageOrder) ? { usageOrder: [...usageOrder] } : {}),
        ...(typeof degraded === 'boolean' ? { degraded } : {}),
    };
}

function decodePrompt(value: unknown): PromptResponse {
    if (!isRecord(value)
        || value['ok'] !== true
        || value['accepted'] !== true
        || typeof value['sessionId'] !== 'string') throw invalidResponse('Code prompt');
    return { ok: true, accepted: true, sessionId: value['sessionId'] };
}

function decodeOk(value: unknown): OkResponse {
    if (!isRecord(value) || value['ok'] !== true) throw invalidResponse('Code request');
    return { ok: true };
}

function decodePermissions(value: unknown): unknown[] {
    if (!isRecord(value) || value['ok'] !== true || !Array.isArray(value['permissions'])) {
        throw invalidResponse('Code permissions');
    }
    return value['permissions'];
}

function isJsonContentType(value: string | null): boolean {
    if (!value) return false;
    const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    return mediaType === 'application/json'
        || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true
        || (!!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

export function createCodeApiClient(port: number, options: CodeApiClientOptions = {}): CodeApiClient {
    const base = `/i/${port}/api/code`;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;

    async function request<T>(
        path: string,
        label: string,
        decode: (value: unknown) => T,
        init?: RequestInit,
        requestOptions: CodeRequestOptions = {},
    ): Promise<T> {
        const headers = new Headers(init?.headers);
        headers.set('Accept', 'application/json');
        if (init?.body !== undefined) headers.set('Content-Type', 'application/json');
        let response: Response;
        try {
            response = await fetchImpl(`${base}${path}`, {
                ...init,
                headers,
                ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
            });
        } catch (error) {
            if (isAbortError(error, requestOptions.signal)) throw error;
            throw new CodeApiError('request_failed', `${label} request failed`);
        }
        if (!response.ok) {
            throw new CodeApiError('http_error', `${label} request failed (${response.status})`, response.status);
        }
        if (!isJsonContentType(response.headers.get('content-type'))) {
            throw new CodeApiError(
                'invalid_content_type',
                `${label} request returned a non-JSON response`,
                response.status,
            );
        }
        let body: unknown;
        try {
            body = await response.json() as unknown;
        } catch {
            throw new CodeApiError('invalid_json', `${label} request returned invalid JSON`, response.status);
        }
        return decode(body);
    }

    const post = <T>(
        path: string,
        label: string,
        decode: (value: unknown) => T,
        body: unknown,
        requestOptions?: CodeRequestOptions,
    ): Promise<T> => request(path, label, decode, {
        method: 'POST',
        body: JSON.stringify(body),
    }, requestOptions);

    return {
        listSessions(requestOptions) {
            return request('/sessions', 'Code sessions', decodeSessions, undefined, requestOptions);
        },
        listStoredSessions(scope, requestOptions) {
            const params = new URLSearchParams();
            if (scope !== undefined) params.set('scope', scope);
            const query = params.size ? `?${params.toString()}` : '';
            return request(`/sessions/stored${query}`, 'Stored Code sessions', decodeStoredSessions, undefined, requestOptions);
        },
        listModelOptions(requestOptions) {
            return request('/models', 'Code models', decodeCodeModelOptions, undefined, requestOptions);
        },
        loadSession(sessionId, cwd, requestOptions) {
            return post('/sessions/load', 'Code session load', decodeSession, { sessionId, cwd }, requestOptions);
        },
        newSession(cwd, model, requestOptions) {
            return post('/sessions', 'Code session create', decodeSession, {
                cwd,
                ...(model ? { model } : {}),
            }, requestOptions);
        },
        setSessionModel(sessionId, modelId, requestOptions) {
            return post(
                `/sessions/${encodeURIComponent(sessionId)}/model`,
                'Code model switch',
                decodeSession,
                { modelId },
                requestOptions,
            );
        },
        closeSession(sessionId, requestOptions) {
            return request(
                `/sessions/${encodeURIComponent(sessionId)}`,
                'Code session close',
                decodeOk,
                { method: 'DELETE' },
                requestOptions,
            );
        },
        prompt(sessionId, text, requestOptions) {
            return post(
                `/sessions/${encodeURIComponent(sessionId)}/prompt`,
                'Code prompt',
                decodePrompt,
                { text },
                requestOptions,
            );
        },
        cancel(sessionId, requestOptions) {
            return post(
                `/sessions/${encodeURIComponent(sessionId)}/cancel`,
                'Code cancel',
                decodeOk,
                {},
                requestOptions,
            );
        },
        listPermissions(requestOptions) {
            return request('/permissions', 'Code permissions', decodePermissions, undefined, requestOptions);
        },
        answerPermission(id, optionId, requestOptions) {
            return post(
                `/permissions/${encodeURIComponent(id)}`,
                'Code permission answer',
                decodeOk,
                { optionId },
                requestOptions,
            );
        },
    };
}
