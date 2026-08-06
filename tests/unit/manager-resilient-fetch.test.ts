import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRetryAfterMs,
    resilientGet,
    type ResilientFetchOptions,
} from '../../public/manager/src/lib/resilient-fetch.ts';

function response(status: number, headers?: HeadersInit): Response {
    return new Response(null, { status, headers });
}

function fetchSequence(responses: Response[]): {
    fetchImpl: typeof fetch;
    calls: RequestInit[];
} {
    const calls: RequestInit[] = [];
    let index = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return responses[Math.min(index++, responses.length - 1)]!;
    };
    return { fetchImpl: fetchImpl as typeof fetch, calls };
}

test('parseRetryAfterMs parses seconds and future dates, rejecting invalid values', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsedDate = parseRetryAfterMs(future);
    assert.ok(parsedDate !== null && parsedDate > 0 && parsedDate <= 60_000);
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs('garbage'), null);
    assert.equal(parseRetryAfterMs('-1'), null);
});

test('429 with Retry-After waits for the specified delay then succeeds', async () => {
    const { fetchImpl, calls } = fetchSequence([
        response(429, { 'Retry-After': '2' }),
        response(200),
    ]);
    const waits: number[] = [];
    const result = await resilientGet('/sessions', {
        fetchImpl,
        delay: async ms => { waits.push(ms); },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(waits, [2000]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.method === 'GET'));
});

test('429 without Retry-After uses full-jitter exponential backoff', async () => {
    const { fetchImpl } = fetchSequence([response(429), response(200)]);
    const waits: number[] = [];
    const opts: ResilientFetchOptions = {
        fetchImpl,
        baseDelayMs: 800,
        random: () => 0.25,
        delay: async ms => { waits.push(ms); },
    };
    const result = await resilientGet('/sessions', opts);
    assert.equal(result.status, 200);
    assert.deepEqual(waits, [200]);
    assert.ok(waits[0]! >= 0 && waits[0]! <= 800);
});

test('retry cap exhaustion returns the last 429 response', async () => {
    const finalResponse = response(429, { 'X-Attempt': 'last' });
    const { fetchImpl, calls } = fetchSequence([response(429), response(429), finalResponse]);
    const result = await resilientGet('/sessions', {
        fetchImpl,
        delay: async () => {},
        random: () => 0,
    });
    assert.equal(result, finalResponse);
    assert.equal(result.headers.get('X-Attempt'), 'last');
    assert.equal(calls.length, 3);
});

test('200 passes through without retries or delay', async () => {
    const success = response(200);
    const { fetchImpl, calls } = fetchSequence([success]);
    let delayCalls = 0;
    const result = await resilientGet('/sessions', {
        fetchImpl,
        delay: async () => { delayCalls++; },
    });
    assert.equal(result, success);
    assert.equal(calls.length, 1);
    assert.equal(delayCalls, 0);
});

test('abort during backoff rejects immediately with AbortError', async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = fetchSequence([response(429), response(200)]);
    let backoffStarted!: () => void;
    const started = new Promise<void>(resolve => { backoffStarted = resolve; });
    const pending = resilientGet('/sessions', {
        fetchImpl,
        signal: controller.signal,
        baseDelayMs: 10_000,
        random: () => {
            backoffStarted();
            return 1;
        },
    });

    await started;
    controller.abort();
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(calls.length, 1, 'must not fetch again after abort');
});
