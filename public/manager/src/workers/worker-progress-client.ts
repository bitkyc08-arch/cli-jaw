export type WorkerRunState = 'running' | 'done' | 'failed' | 'cancelled';

export type WorkerProgressAttentionKind =
    | 'stalled'
    | 'disconnected'
    | 'timeout'
    | 'pending_replay'
    | 'replay_claimed'
    | 'replay_failed';

export interface WorkerProgressAttention {
    kind: WorkerProgressAttentionKind;
    message: string;
    occurredAt: number;
    exitCode?: number | null;
    attempts?: number;
}

export interface WorkerProgressTool {
    icon?: string;
    label?: string;
    detail?: string;
    status?: string;
    stepRef?: string;
    toolType?: string;
}

export interface WorkerProgressRun {
    agentId: string;
    employeeName: string;
    state: WorkerRunState;
    taskPreview: string;
    phase?: string | null;
    phaseLabel?: string | null;
    startedAt: number;
    completedAt: number | null;
    progressUpdatedAt: number | null;
    resultPreview?: string;
    attention?: WorkerProgressAttention;
    tools: WorkerProgressTool[];
}

export interface WorkerProgressSnapshot {
    agentId: string;
    employeeName: string;
    current: WorkerProgressRun | null;
    previous: WorkerProgressRun | null;
    generatedAt: number;
}

export interface WorkerProgressClient {
    listWorkers(): Promise<WorkerProgressSnapshot[]>;
    getWorker(agentId: string): Promise<WorkerProgressSnapshot>;
}

type FetchImpl = typeof fetch;
type EventSourceLike = Pick<EventSource, 'onmessage' | 'onerror' | 'close'>;
export type WorkerProgressEventSourceCtor = new (url: string) => EventSourceLike;

export interface WorkerProgressSubscription {
    close(): void;
}

export interface WorkerProgressSubscriptionOptions {
    baseUrl?: string;
    EventSourceImpl?: WorkerProgressEventSourceCtor;
    onRefreshNeeded: (reason: string) => void;
    onReplayGap?: () => void;
    onError?: (event: Event) => void;
}

function workerUrl(baseUrl: string, path: string): string {
    return `${baseUrl}${path}`;
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
    const text = await response.text();
    let body: unknown = {};
    if (text.trim()) {
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            throw new Error(`${fallback}: response was not JSON`);
        }
    }
    if (!response.ok) {
        const message = typeof body === 'object' && body && 'error' in body
            ? String((body as { error?: unknown }).error)
            : fallback;
        throw new Error(message || fallback);
    }
    return body as T;
}

export function createWorkerProgressClient(options: { baseUrl?: string; fetchImpl?: FetchImpl } = {}): WorkerProgressClient {
    const baseUrl = options.baseUrl ?? '';
    const fetchImpl = options.fetchImpl ?? fetch;

    return {
        async listWorkers() {
            const body = await parseResponse<{ workers: WorkerProgressSnapshot[] }>(
                await fetchImpl(workerUrl(baseUrl, '/api/orchestrate/worker-progress')),
                'worker progress list failed',
            );
            return body.workers;
        },
        async getWorker(agentId: string) {
            const body = await parseResponse<{ progress: WorkerProgressSnapshot }>(
                await fetchImpl(workerUrl(baseUrl, `/api/orchestrate/worker-progress/${encodeURIComponent(agentId)}`)),
                'worker progress read failed',
            );
            return body.progress;
        },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function eventsUrl(baseUrl?: string): string {
    if (baseUrl) return `${baseUrl}/api/events`;
    if (typeof window !== 'undefined' && window.location.origin) return `${window.location.origin}/api/events`;
    return '/api/events';
}

function refreshReason(frame: Record<string, unknown>): string | null {
    if (frame['topic'] === 'system' && frame['event'] === 'replay_gap') return 'replay_gap';
    if (frame['topic'] === 'worker' && typeof frame['event'] === 'string') return String(frame['event']);
    if (frame['topic'] === 'agent' && frame['isEmployee'] === true) {
        const event = String(frame['event'] || '');
        if (event === 'agent_tool' || event === 'agent_status' || event === 'agent_done') return event;
    }
    return null;
}

export function subscribeToWorkerProgressEvents(options: WorkerProgressSubscriptionOptions): WorkerProgressSubscription {
    const EventSourceImpl = options.EventSourceImpl ?? EventSource;
    const source = new EventSourceImpl(eventsUrl(options.baseUrl));

    source.onmessage = (event: MessageEvent) => {
        let frame: unknown;
        try {
            frame = JSON.parse(String(event.data)) as unknown;
        } catch {
            return;
        }
        if (!isObject(frame)) return;
        const reason = refreshReason(frame);
        if (!reason) return;
        if (reason === 'replay_gap') options.onReplayGap?.();
        options.onRefreshNeeded(reason);
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
