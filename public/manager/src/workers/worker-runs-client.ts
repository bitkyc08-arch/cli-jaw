export type WorkerRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type WorkerRunEventType =
    | 'worker_run_started'
    | 'worker_run_progress'
    | 'worker_run_attention'
    | 'worker_run_done'
    | 'worker_run_failed'
    | 'worker_run_cancelled';

export interface WorkerRunRecord {
    runId: string;
    agentId: string;
    employeeName: string;
    taskPreview: string;
    startedAt: number;
    status: WorkerRunStatus;
    updatedAt: number;
    completedAt: number | null;
    outputBytes: number;
    eventSeq: number;
    safeSummary?: string;
    hasOutput: boolean;
}

export interface WorkerRunEvent {
    runId: string;
    seq: number;
    event: WorkerRunEventType;
    ts: number;
    data: Record<string, unknown>;
}

export interface WorkerRunOutput {
    runId: string;
    offset: number;
    limit: number;
    nextOffset: number;
    outputBytes: number;
    eof: boolean;
    text: string;
}

export interface WorkerRunsClient {
    listRuns(): Promise<WorkerRunRecord[]>;
    getRunEvents(runId: string): Promise<WorkerRunEvent[]>;
    readRunOutput(runId: string, input?: { offset?: number; limit?: number }): Promise<WorkerRunOutput>;
}

type FetchImpl = typeof fetch;

function workerRunUrl(baseUrl: string, path: string): string {
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

function outputPath(runId: string, input: { offset?: number; limit?: number } = {}): string {
    const params = new URLSearchParams();
    if (input.offset !== undefined) params.set('offset', String(input.offset));
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    const suffix = params.toString();
    return `/api/orchestrate/worker-runs/${encodeURIComponent(runId)}/output${suffix ? `?${suffix}` : ''}`;
}

export function createWorkerRunsClient(options: { baseUrl?: string; fetchImpl?: FetchImpl } = {}): WorkerRunsClient {
    const baseUrl = options.baseUrl ?? '';
    const fetchImpl = options.fetchImpl ?? fetch;

    return {
        async listRuns() {
            const body = await parseResponse<{ runs: WorkerRunRecord[] }>(
                await fetchImpl(workerRunUrl(baseUrl, '/api/orchestrate/worker-runs')),
                'worker runs list failed',
            );
            return body.runs;
        },
        async getRunEvents(runId: string) {
            const body = await parseResponse<{ events: WorkerRunEvent[] }>(
                await fetchImpl(workerRunUrl(baseUrl, `/api/orchestrate/worker-runs/${encodeURIComponent(runId)}/events`)),
                'worker run events read failed',
            );
            return body.events;
        },
        async readRunOutput(runId: string, input = {}) {
            const body = await parseResponse<{ output: WorkerRunOutput }>(
                await fetchImpl(workerRunUrl(baseUrl, outputPath(runId, input))),
                'worker run output read failed',
            );
            return body.output;
        },
    };
}
