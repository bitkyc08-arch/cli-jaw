import type {
    MessagesPageResponse,
    SegmentedMessageItem,
    TurnSegment,
} from '../../../../../src/shared/chat-events.ts';

export interface MessagesPageOptions {
    limit?: number;
    before?: number;
}

export type MessagesPageFetchResult =
    | { status: 'ok'; page: MessagesPageResponse }
    | { status: 'aborted' }
    | { status: 'stale' };

export interface MessagesPageClient {
    beginScope(scopeKey: string): number;
    fetch(opts?: MessagesPageOptions, signal?: AbortSignal): Promise<MessagesPageFetchResult>;
    abortAll(): void;
    generation(): number;
}

export class InvalidMessagesPageResponseError extends Error {
    constructor() {
        super('Instance returned an invalid messages page response');
        this.name = 'InvalidMessagesPageResponseError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isDetailRef(value: unknown): boolean {
    return value === null || (isRecord(value)
        && typeof value['traceRunId'] === 'string'
        && Number.isInteger(value['traceSeq'])
        && (value['traceSeq'] as number) >= 0);
}

function isTurnSegment(value: unknown): value is TurnSegment {
    if (!isRecord(value)) return false;
    return typeof value['turnId'] === 'string'
        && Number.isInteger(value['turnSeq'])
        && (value['turnSeq'] as number) >= 0
        && typeof value['segmentId'] === 'string'
        && typeof value['sessionId'] === 'string'
        && typeof value['createdAt'] === 'number'
        && Number.isFinite(value['createdAt'])
        && typeof value['observedAt'] === 'number'
        && Number.isFinite(value['observedAt'])
        && isNullableNumber(value['providerAt'])
        && (value['fidelity'] === null || value['fidelity'] === 'full' || value['fidelity'] === 'coarse' || value['fidelity'] === 'text_only')
        && (value['thinkingMarker'] === null || typeof value['thinkingMarker'] === 'string')
        && typeof value['type'] === 'string'
        && typeof value['status'] === 'string'
        && isDetailRef(value['detailRef']);
}

function isMessage(value: unknown): value is SegmentedMessageItem {
    if (!isRecord(value)) return false;
    return Number.isInteger(value['id'])
        && (value['id'] as number) > 0
        && typeof value['role'] === 'string'
        && typeof value['content'] === 'string'
        && isNullableString(value['cli'])
        && isNullableString(value['model'])
        && isNullableString(value['tool_log'])
        && isNullableString(value['trace_run_id'])
        && isNullableString(value['turn_id'])
        && isNullableNumber(value['cost_usd'])
        && isNullableNumber(value['duration_ms'])
        && isNullableString(value['working_dir'])
        && typeof value['created_at'] === 'string'
        && Array.isArray(value['turn_segments'])
        && value['turn_segments'].every(isTurnSegment);
}

export function isMessagesPageResponse(value: unknown): value is MessagesPageResponse {
    if (!isRecord(value) || value['ok'] !== true || !Array.isArray(value['data']) || !isRecord(value['pageInfo'])) {
        return false;
    }
    const pageInfo = value['pageInfo'];
    return value['data'].every(isMessage)
        && (pageInfo['oldestCursor'] === null || (Number.isInteger(pageInfo['oldestCursor']) && (pageInfo['oldestCursor'] as number) > 0))
        && (pageInfo['newestCursor'] === null || (Number.isInteger(pageInfo['newestCursor']) && (pageInfo['newestCursor'] as number) > 0))
        && typeof pageInfo['hasMoreBefore'] === 'boolean'
        && Number.isInteger(pageInfo['limit'])
        && (pageInfo['limit'] as number) > 0
        && Number.isInteger(value['snapshotEventSeq'])
        && (value['snapshotEventSeq'] as number) >= 0;
}

function validateOptions(opts: MessagesPageOptions): void {
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
        throw new RangeError('messages page limit must be a positive integer');
    }
    if (opts.before !== undefined && (!Number.isInteger(opts.before) || opts.before <= 0)) {
        throw new RangeError('messages page before cursor must be a positive integer');
    }
}

export function createMessagesPageClient(
    fetchPage: (opts: MessagesPageOptions) => Promise<MessagesPageResponse>,
): MessagesPageClient {
    let scopeKey: string | null = null;
    let scopeGeneration = 0;
    const active = new Set<AbortController>();

    function abortAll(): void {
        for (const controller of active) controller.abort();
        active.clear();
    }

    function beginScope(nextScopeKey: string): number {
        if (scopeKey === nextScopeKey) return scopeGeneration;
        abortAll();
        scopeKey = nextScopeKey;
        scopeGeneration += 1;
        return scopeGeneration;
    }

    async function fetchPageForScope(
        opts: MessagesPageOptions = {},
        signal?: AbortSignal,
    ): Promise<MessagesPageFetchResult> {
        validateOptions(opts);
        const token = scopeGeneration;
        const controller = new AbortController();
        active.add(controller);
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) controller.abort();

        try {
            if (controller.signal.aborted) return { status: 'aborted' };
            const aborted = new Promise<MessagesPageFetchResult>(resolve => {
                controller.signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true });
            });
            const loaded = fetchPage(opts).then((page): MessagesPageFetchResult => {
                if (controller.signal.aborted) return { status: 'aborted' };
                if (token !== scopeGeneration) return { status: 'stale' };
                if (!isMessagesPageResponse(page)) throw new InvalidMessagesPageResponseError();
                return { status: 'ok', page };
            });
            return await Promise.race([loaded, aborted]);
        } finally {
            signal?.removeEventListener('abort', onAbort);
            active.delete(controller);
        }
    }

    return {
        beginScope,
        fetch: fetchPageForScope,
        abortAll,
        generation: () => scopeGeneration,
    };
}
