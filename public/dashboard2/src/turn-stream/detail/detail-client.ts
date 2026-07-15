export interface TraceDetailFullData {
    runId: string;
    seq: number;
    source: string;
    eventType: string;
    preview: string;
    bytes: number;
    retentionStatus: string;
    createdAt: number;
    raw: string;
}

export interface TraceDetailRangeData {
    runId: string;
    seq: number;
    totalBytes: number;
    requestedOffset: number;
    requestedLimit: number;
    actualStart: number;
    actualEndExclusive: number;
    nextOffset: number | null;
    eof: boolean;
    text: string;
    contentEncoding: 'utf-8';
    line: { first: number; last: number; indexStrideBytes: number };
    boundary: {
        utf8Adjusted: boolean;
        startsAtLineBoundary: boolean;
        ansiStateBefore: string | null;
        ansiStateAfter: string | null;
    };
    revision: string;
}

export type DetailClientResult =
    | { kind: 'full'; data: TraceDetailFullData }
    | { kind: 'range'; data: TraceDetailRangeData }
    | { kind: 'bad-range'; status: 400; error: string }
    | { kind: 'not-found'; status: 404; error: 'trace_not_found' | 'trace_event_not_found' }
    | { kind: 'revision-changed'; status: 409; error: 'trace_payload_revision_changed' }
    | { kind: 'gone'; status: 410; error: 'trace_payload_gone' }
    | { kind: 'range-required'; status: 413; error: 'trace_detail_range_required'; totalBytes: number; rangeAvailable: true; chunkSize: number }
    | { kind: 'invalid-utf8'; status: 422; error: 'trace_payload_invalid_utf8' }
    | { kind: 'error'; status: number; error: string };

type FetchLike = typeof fetch;

export function workerApiBase(port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid worker port');
    return `/i/${port}`;
}

export function workerApiUrl(port: number, path: string): string {
    if (!path.startsWith('/api/')) throw new Error('Worker API path must start with /api/');
    return `${workerApiBase(port)}${path}`;
}

function endpoint(apiBase: string, runId: string, seq: number, offset?: number, limit?: number): string {
    if (!apiBase) throw new Error('Worker API base is required');
    const base = `${apiBase.replace(/\/$/, '')}/api/traces/${encodeURIComponent(runId)}/events/${seq}`;
    if (offset === undefined) return base;
    const query = new URLSearchParams({ offset: String(offset) });
    if (limit !== undefined) query.set('limit', String(limit));
    return `${base}?${query}`;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export async function fetchTraceDetail(
    runId: string,
    seq: number,
    options: { offset?: number; limit?: number; signal?: AbortSignal; fetcher?: FetchLike; apiBase?: string } = {},
): Promise<DetailClientResult> {
    if (!options.apiBase) throw new Error('Worker API base is required');
    const init: RequestInit = options.signal ? { signal: options.signal } : {};
    const response = await (options.fetcher ?? fetch)(
        endpoint(options.apiBase, runId, seq, options.offset, options.limit), init,
    );
    const body = record(await response.json().catch(() => ({})));
    if (response.ok) {
        const data = record(body['data']);
        return typeof data['raw'] === 'string'
            ? { kind: 'full', data: data as unknown as TraceDetailFullData }
            : { kind: 'range', data: data as unknown as TraceDetailRangeData };
    }
    const error = typeof body['error'] === 'string' ? body['error'] : `http_${response.status}`;
    if (response.status === 400) return { kind: 'bad-range', status: 400, error };
    if (response.status === 404 && (error === 'trace_not_found' || error === 'trace_event_not_found')) {
        return { kind: 'not-found', status: 404, error };
    }
    if (response.status === 409 && error === 'trace_payload_revision_changed') {
        return { kind: 'revision-changed', status: 409, error };
    }
    if (response.status === 410 && error === 'trace_payload_gone') return { kind: 'gone', status: 410, error };
    if (response.status === 413 && error === 'trace_detail_range_required') {
        return {
            kind: 'range-required', status: 413, error,
            totalBytes: Number(body['totalBytes']), rangeAvailable: true, chunkSize: Number(body['chunkSize']),
        };
    }
    if (response.status === 422 && error === 'trace_payload_invalid_utf8') return { kind: 'invalid-utf8', status: 422, error };
    return { kind: 'error', status: response.status, error };
}
