export type BackgroundTaskStatus = 'running' | 'complete' | 'failed' | 'cancelled' | 'orphaned';

export type BackgroundTaskCompletion =
    | { type: 'exit' }
    | { type: 'json-line'; match: Record<string, string> }
    | { type: 'line-pattern'; regex: string }
    | { type: 'session-status'; sessionId: string };

export type BackgroundTaskResultExtractor =
    | { type: 'tail-lines'; n: number }
    | { type: 'matched-line' }
    | { type: 'command'; command: string[] }
    | { type: 'session-answer' };

export interface BackgroundTaskSpec {
    command?: string[];
    cwd?: string;
    env?: Record<string, string>;
    completion: BackgroundTaskCompletion;
    resultExtractor?: BackgroundTaskResultExtractor;
    promptTemplate: string;
    policy?: 'queue';
    stallAfterMs?: number;
    maxResultChars?: number;
    respawn?: boolean;
    deadlineAt?: string;
}

export interface BackgroundTaskOriginMeta {
    origin?: string;
    target?: unknown;
    chatId?: string | number;
}

export interface BackgroundTaskRow {
    id: string;
    kind: string;
    spec: BackgroundTaskSpec;
    status: BackgroundTaskStatus;
    pid: number | null;
    originMeta: BackgroundTaskOriginMeta;
    result: string | null;
    createdAt: string | null;
    startedAt: string | null;
    deadlineAt: string | null;
    completedAt: string | null;
    notifiedAt: string | null;
    runnerActive?: boolean;
}

export interface BackgroundTaskRunningSnapshot {
    id: string;
    kind: string;
    startedAt?: string | null;
}

export interface BackgroundTaskChangedSnapshot {
    id: string;
    kind: string;
    status: BackgroundTaskStatus;
}

export interface BackgroundTaskUpdate {
    topic: 'bgtask';
    event: 'bgtask_update';
    running: BackgroundTaskRunningSnapshot[];
    changed: BackgroundTaskChangedSnapshot | null;
    sseReplay?: boolean;
}

export type BackgroundTaskCreateInput =
    | {
        preset: 'web-ai';
        sessionId: string;
        prompt?: string;
        deadlineAt?: string;
        originMeta?: BackgroundTaskOriginMeta;
    }
    | {
        kind?: string;
        spec: BackgroundTaskSpec;
        originMeta?: BackgroundTaskOriginMeta;
    };

export interface BackgroundTaskClient {
    listTasks(options?: { status?: BackgroundTaskStatus; limit?: number }): Promise<BackgroundTaskRow[]>;
    getTask(id: string): Promise<BackgroundTaskRow>;
    createTask(input: BackgroundTaskCreateInput): Promise<{ task: BackgroundTaskRow; warnings: string[] }>;
    cancelTask(id: string): Promise<{ cancelled: boolean; task: BackgroundTaskRow | null }>;
}

export class BackgroundTaskApiError extends Error {
    status: number;
    code: string | null;
    existingId: string | null;

    constructor(message: string, status: number, code: string | null = null, existingId: string | null = null) {
        super(message);
        this.name = 'BackgroundTaskApiError';
        this.status = status;
        this.code = code;
        this.existingId = existingId;
    }
}

type FetchImpl = typeof fetch;

type EventSourceLike = Pick<EventSource, 'onmessage' | 'onerror' | 'close'>;
export type BackgroundTaskEventSourceCtor = new (url: string) => EventSourceLike;

export interface BackgroundTaskSubscription {
    close(): void;
}

export interface BackgroundTaskSubscriptionOptions {
    baseUrl?: string;
    EventSourceImpl?: BackgroundTaskEventSourceCtor;
    onUpdate: (update: BackgroundTaskUpdate) => void;
    onReplayGap?: () => void;
    onError?: (event: Event) => void;
}

function taskUrl(baseUrl: string, path: string): string {
    return `${baseUrl}${path}`;
}

function queryString(options: { status?: BackgroundTaskStatus; limit?: number }): string {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (Number.isFinite(options.limit) && Number(options.limit) > 0) params.set('limit', String(options.limit));
    const query = params.toString();
    return query ? `?${query}` : '';
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
    const text = await response.text();
    let body: unknown = {};
    if (text.trim()) {
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            throw new BackgroundTaskApiError(`${fallback}: response was not JSON`, response.status, 'invalid_json');
        }
    }
    if (!response.ok) {
        const message = typeof body === 'object' && body && 'error' in body
            ? String((body as { error?: unknown }).error)
            : fallback;
        const existingId = typeof body === 'object' && body && 'existingId' in body && typeof (body as { existingId?: unknown }).existingId === 'string'
            ? (body as { existingId: string }).existingId
            : null;
        throw new BackgroundTaskApiError(message || fallback, response.status, null, existingId);
    }
    return body as T;
}

export function createBackgroundTaskClient(options: { baseUrl?: string; fetchImpl?: FetchImpl } = {}): BackgroundTaskClient {
    const baseUrl = options.baseUrl ?? '';
    const fetchImpl = options.fetchImpl ?? fetch;

    return {
        async listTasks(filter = {}) {
            const body = await parseResponse<{ tasks: BackgroundTaskRow[] }>(
                await fetchImpl(taskUrl(baseUrl, `/api/bgtask${queryString(filter)}`)),
                'background task list failed',
            );
            return body.tasks;
        },
        async getTask(id: string) {
            const body = await parseResponse<{ task: BackgroundTaskRow }>(
                await fetchImpl(taskUrl(baseUrl, `/api/bgtask/${encodeURIComponent(id)}`)),
                'background task read failed',
            );
            return body.task;
        },
        async createTask(input: BackgroundTaskCreateInput) {
            const body = await parseResponse<{ task: BackgroundTaskRow; warnings?: string[] }>(
                await fetchImpl(taskUrl(baseUrl, '/api/bgtask'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(input),
                }),
                'background task create failed',
            );
            return { task: body.task, warnings: body.warnings ?? [] };
        },
        async cancelTask(id: string) {
            const body = await parseResponse<{ cancelled: boolean; task: BackgroundTaskRow | null }>(
                await fetchImpl(taskUrl(baseUrl, `/api/bgtask/${encodeURIComponent(id)}`), { method: 'DELETE' }),
                'background task cancel failed',
            );
            return { cancelled: body.cancelled, task: body.task };
        },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isStatus(value: unknown): value is BackgroundTaskStatus {
    return value === 'running'
        || value === 'complete'
        || value === 'failed'
        || value === 'cancelled'
        || value === 'orphaned';
}

function normalizeRunning(value: unknown): BackgroundTaskRunningSnapshot[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (!isObject(entry) || typeof entry['id'] !== 'string' || typeof entry['kind'] !== 'string') return [];
        return [{
            id: entry['id'],
            kind: entry['kind'],
            ...(typeof entry['startedAt'] === 'string' || entry['startedAt'] === null ? { startedAt: entry['startedAt'] } : {}),
        }];
    });
}

function normalizeChanged(value: unknown): BackgroundTaskChangedSnapshot | null {
    if (!isObject(value)) return null;
    if (typeof value['id'] !== 'string' || typeof value['kind'] !== 'string' || !isStatus(value['status'])) return null;
    return { id: value['id'], kind: value['kind'], status: value['status'] };
}

export function normalizeBackgroundTaskUpdate(frame: unknown): BackgroundTaskUpdate | null {
    if (!isObject(frame)) return null;
    if (frame['topic'] !== 'bgtask' || frame['event'] !== 'bgtask_update') return null;
    return {
        topic: 'bgtask',
        event: 'bgtask_update',
        running: normalizeRunning(frame['running']),
        changed: normalizeChanged(frame['changed']),
        ...(frame['sseReplay'] === true ? { sseReplay: true } : {}),
    };
}

function eventsUrl(baseUrl?: string): string {
    if (baseUrl) return `${baseUrl}/api/events`;
    if (typeof window !== 'undefined' && window.location.origin) return `${window.location.origin}/api/events`;
    return '/api/events';
}

export function subscribeToBackgroundTaskUpdates(options: BackgroundTaskSubscriptionOptions): BackgroundTaskSubscription {
    const EventSourceImpl = options.EventSourceImpl ?? EventSource;
    const source = new EventSourceImpl(eventsUrl(options.baseUrl));

    source.onmessage = (event: MessageEvent) => {
        let frame: unknown;
        try {
            frame = JSON.parse(String(event.data)) as unknown;
        } catch {
            return;
        }
        if (isObject(frame) && frame['topic'] === 'system' && frame['event'] === 'replay_gap') {
            options.onReplayGap?.();
            return;
        }
        const update = normalizeBackgroundTaskUpdate(frame);
        if (update) options.onUpdate(update);
    };
    source.onerror = (event: Event) => {
        options.onError?.(event);
    };

    return {
        close() {
            source.close();
        },
    };
}
