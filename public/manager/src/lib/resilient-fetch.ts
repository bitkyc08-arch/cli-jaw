const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_TOTAL_WAIT_MS = 10_000;

type Delay = (ms: number, signal?: AbortSignal) => Promise<void>;

export type ResilientFetchOptions = {
    retries?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
    /** Dependency injection for deterministic unit tests. */
    fetchImpl?: typeof fetch;
    delay?: Delay;
    random?: () => number;
};

export function parseRetryAfterMs(header: string | null): number | null {
    const value = header?.trim();
    if (!value) return null;

    if (/^\d+$/.test(value)) {
        const seconds = Number(value);
        const delayMs = seconds * 1000;
        return Number.isSafeInteger(delayMs) ? delayMs : null;
    }

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    const delayMs = timestamp - Date.now();
    return delayMs > 0 ? delayMs : null;
}

function abortError(): DOMException {
    return new DOMException('The operation was aborted.', 'AbortError');
}

function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function boundedInteger(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
}

export async function resilientGet(
    url: string,
    opts: ResilientFetchOptions = {},
): Promise<Response> {
    const retries = boundedInteger(opts.retries, DEFAULT_RETRIES);
    const baseDelayMs = boundedInteger(opts.baseDelayMs, DEFAULT_BASE_DELAY_MS);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const delay = opts.delay ?? defaultDelay;
    const random = opts.random ?? Math.random;
    const requestInit: RequestInit = {
        method: 'GET',
        ...(opts.signal ? { signal: opts.signal } : {}),
    };
    let totalWaitMs = 0;
    let response = await fetchImpl(url, requestInit);

    for (let attempt = 0; response.status === 429 && attempt < retries; attempt++) {
        const remainingWaitMs = MAX_TOTAL_WAIT_MS - totalWaitMs;
        if (remainingWaitMs <= 0) return response;

        // RFC 6585 clients may honor Retry-After. Without it, use AWS-style
        // full jitter over a capped exponential backoff to avoid retry herds
        // (rate-limit hardening research 001 §B).
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        const backoffCapMs = Math.min(baseDelayMs * (2 ** attempt), MAX_TOTAL_WAIT_MS);
        const jitter = Math.min(1, Math.max(0, random())) * backoffCapMs;
        const waitMs = Math.min(retryAfterMs ?? jitter, remainingWaitMs);
        await delay(waitMs, opts.signal);
        totalWaitMs += waitMs;
        response = await fetchImpl(url, requestInit);
    }

    return response;
}
