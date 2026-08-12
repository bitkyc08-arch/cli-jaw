import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    DiscordRestScheduler,
    type DiscordRestRequest,
} from '../../src/discord/rest-scheduler.ts';
import {
    invalidateDiscordSendClient,
    sendDiscordFileRest,
    sendDiscordTextRest,
} from '../../src/discord/send-only-client.ts';

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function request(
    label: string,
    options: Partial<DiscordRestRequest<string>> = {},
): DiscordRestRequest<string> {
    return {
        method: 'POST',
        path: `/${label}`,
        routeKey: `POST:/${label}`,
        majorKey: 'channel-1',
        makeInit: () => ({ headers: { 'x-test-label': label } }),
        parse: async () => label,
        ...options,
    };
}

function rateResponse(options: {
    bucket?: string;
    remaining?: number;
    resetAfter?: string;
    retryAfter?: string;
    global?: boolean;
    body?: string;
} = {}): Response {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (options.bucket) headers.set('x-ratelimit-bucket', options.bucket);
    if (options.remaining !== undefined) headers.set('x-ratelimit-remaining', String(options.remaining));
    if (options.resetAfter !== undefined) headers.set('x-ratelimit-reset-after', options.resetAfter);
    if (options.retryAfter !== undefined) headers.set('retry-after', options.retryAfter);
    if (options.global) headers.set('x-ratelimit-global', 'true');
    return new Response(options.body ?? JSON.stringify({
        message: 'rate limited',
        ...(options.global ? { global: true } : {}),
    }), { status: 429, headers });
}

function bucketResponse(bucket: string, remaining = 1, resetAfter?: string): Response {
    const headers: Record<string, string> = {
        'x-ratelimit-bucket': bucket,
        'x-ratelimit-remaining': String(remaining),
    };
    if (resetAfter !== undefined) headers['x-ratelimit-reset-after'] = resetAfter;
    return new Response(null, { status: 204, headers });
}

async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test('same route and major serializes while distinct major keys proceed independently', async () => {
    const gates = new Map<string, Deferred<Response>>();
    const starts: string[] = [];
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        fetchImpl: (async (url) => {
            const label = new URL(String(url)).pathname.slice('/api/v10/'.length);
            starts.push(label);
            const gate = deferred<Response>();
            gates.set(label, gate);
            return gate.promise;
        }) as typeof fetch,
    });

    const first = scheduler.schedule(request('same-1', { routeKey: 'POST:/messages' }));
    const second = scheduler.schedule(request('same-2', { routeKey: 'POST:/messages' }));
    const other = scheduler.schedule(request('other', {
        routeKey: 'POST:/messages',
        majorKey: 'channel-2',
    }));
    await flush();
    assert.deepEqual(starts, ['same-1', 'other']);

    gates.get('same-1')!.resolve(bucketResponse('bucket-a'));
    gates.get('other')!.resolve(bucketResponse('bucket-a'));
    await flush();
    assert.deepEqual(starts, ['same-1', 'other', 'same-2']);
    gates.get('same-2')!.resolve(bucketResponse('bucket-a'));
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal((await other).ok, true);
});

test('canonical lane union merges pending queues and fences them behind both discovery requests', async () => {
    const gates = new Map<string, Deferred<Response>>();
    const starts: string[] = [];
    let onWire = 0;
    let peakAfterDiscovery = 0;
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        fetchImpl: (async (url) => {
            const label = new URL(String(url)).pathname.slice('/api/v10/'.length);
            starts.push(label);
            onWire += 1;
            if (starts.length > 2) peakAfterDiscovery = Math.max(peakAfterDiscovery, onWire);
            const gate = deferred<Response>();
            gates.set(label, gate);
            try {
                return await gate.promise;
            } finally {
                onWire -= 1;
            }
        }) as typeof fetch,
    });

    const jobs = [
        scheduler.schedule(request('route-a-1', { routeKey: 'POST:/route-a' })),
        scheduler.schedule(request('route-b-1', { routeKey: 'POST:/route-b' })),
        scheduler.schedule(request('route-a-2', { routeKey: 'POST:/route-a' })),
        scheduler.schedule(request('route-b-2', { routeKey: 'POST:/route-b' })),
    ];
    await flush();
    assert.deepEqual(starts, ['route-a-1', 'route-b-1']);

    gates.get('route-a-1')!.resolve(bucketResponse('shared'));
    gates.get('route-b-1')!.resolve(bucketResponse('shared'));
    await flush();
    assert.deepEqual(starts, ['route-a-1', 'route-b-1', 'route-a-2']);
    gates.get('route-a-2')!.resolve(bucketResponse('shared'));
    await flush();
    assert.deepEqual(starts, ['route-a-1', 'route-b-1', 'route-a-2', 'route-b-2']);
    gates.get('route-b-2')!.resolve(bucketResponse('shared'));

    const results = await Promise.all(jobs);
    assert.ok(results.every((result) => result.ok));
    assert.equal(peakAfterDiscovery, 1);
});

test('equal bucket hashes never merge different major parameters', async () => {
    const starts: string[] = [];
    const secondWave = new Map<string, Deferred<Response>>();
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        fetchImpl: (async (url) => {
            const label = new URL(String(url)).pathname.slice('/api/v10/'.length);
            starts.push(label);
            if (label.endsWith('-1')) return bucketResponse('same-hash');
            const gate = deferred<Response>();
            secondWave.set(label, gate);
            return gate.promise;
        }) as typeof fetch,
    });

    await Promise.all([
        scheduler.schedule(request('major-a-1', { routeKey: 'POST:/messages', majorKey: 'a' })),
        scheduler.schedule(request('major-b-1', { routeKey: 'POST:/messages', majorKey: 'b' })),
    ]);
    const a = scheduler.schedule(request('major-a-2', { routeKey: 'POST:/messages', majorKey: 'a' }));
    const b = scheduler.schedule(request('major-b-2', { routeKey: 'POST:/messages', majorKey: 'b' }));
    await flush();
    assert.deepEqual(new Set(starts.slice(-2)), new Set(['major-a-2', 'major-b-2']));
    secondWave.get('major-a-2')!.resolve(bucketResponse('same-hash'));
    secondWave.get('major-b-2')!.resolve(bucketResponse('same-hash'));
    await Promise.all([a, b]);
});

test('remaining zero waits through the reset before the next fetch', async () => {
    let now = 1_000;
    const waits: number[] = [];
    let calls = 0;
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        now: () => now,
        sleep: async (ms) => { waits.push(ms); now += ms; },
        fetchImpl: (async () => {
            calls += 1;
            return calls === 1 ? bucketResponse('bucket', 0, '0.125') : bucketResponse('bucket');
        }) as typeof fetch,
    });
    const first = scheduler.schedule(request('reset-1', { routeKey: 'POST:/messages' }));
    const second = scheduler.schedule(request('reset-2', { routeKey: 'POST:/messages' }));
    await Promise.all([first, second]);
    assert.deepEqual(waits, [125]);
});

test('lane union keeps the minimum remaining count and maximum reset deadline', async () => {
    let now = 0;
    const waits: number[] = [];
    const firstA = deferred<Response>();
    const firstB = deferred<Response>();
    const starts: string[] = [];
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        now: () => now,
        sleep: async (ms) => { waits.push(ms); now += ms; },
        fetchImpl: (async (url) => {
            const label = new URL(String(url)).pathname.slice('/api/v10/'.length);
            starts.push(label);
            if (label === 'state-a-1') return firstA.promise;
            if (label === 'state-b-1') return firstB.promise;
            return bucketResponse('shared-state');
        }) as typeof fetch,
    });
    const jobs = [
        scheduler.schedule(request('state-a-1', { routeKey: 'POST:/state-a' })),
        scheduler.schedule(request('state-b-1', { routeKey: 'POST:/state-b' })),
        scheduler.schedule(request('state-a-2', { routeKey: 'POST:/state-a' })),
        scheduler.schedule(request('state-b-2', { routeKey: 'POST:/state-b' })),
    ];
    await flush();
    firstA.resolve(bucketResponse('shared-state', 1, '0.1'));
    firstB.resolve(bucketResponse('shared-state', 0, '0.2'));
    await Promise.all(jobs);
    assert.deepEqual(waits, [200]);
    assert.deepEqual(starts, ['state-a-1', 'state-b-1', 'state-a-2', 'state-b-2']);
});

test('route 429 gates only its lane while a global 429 gates every lane', async () => {
    for (const global of [false, true]) {
        let now = 0;
        const waits: Array<Deferred<void>> = [];
        const starts: string[] = [];
        let limited = false;
        const scheduler = new DiscordRestScheduler({
            token: 'token',
            now: () => now,
            sleep: async (_ms, signal) => {
                const gate = deferred<void>();
                waits.push(gate);
                signal.addEventListener('abort', () => gate.reject(signal.reason), { once: true });
                return gate.promise;
            },
            fetchImpl: (async (url) => {
                const label = new URL(String(url)).pathname.slice('/api/v10/'.length);
                starts.push(label);
                if (label === 'limited' && !limited) {
                    limited = true;
                    return rateResponse({ retryAfter: '0.01', global });
                }
                return new Response(null, { status: 204 });
            }) as typeof fetch,
        });

        const first = scheduler.schedule(request('limited'));
        await flush();
        const other = scheduler.schedule(request('other-lane', { majorKey: 'channel-2' }));
        await flush();
        assert.equal(starts.includes('other-lane'), !global);

        now = 10;
        for (const gate of waits) gate.resolve();
        await Promise.all([first, other]);
        assert.equal(starts.filter((label) => label === 'limited').length, 2);
        assert.equal(starts.filter((label) => label === 'other-lane').length, 1);
    }
});

test('decimal retry headers and JSON fallback are converted to ceil milliseconds', async () => {
    for (const [response, expected] of [
        [rateResponse({ retryAfter: '0.0015', body: '{bad json' }), 2],
        [rateResponse({ body: JSON.stringify({ retry_after: 0.0025 }) }), 3],
    ] as const) {
        const scheduler = new DiscordRestScheduler({
            token: 'token',
            maxRetries: 0,
            fetchImpl: (async () => response) as typeof fetch,
        });
        const result = await scheduler.schedule(request('decimal'));
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.failure.retryAfterMs, expected);
    }
});

test('retry is bounded, exponentially backed off, and rebuilds the init each attempt', async () => {
    let now = 0;
    const waits: number[] = [];
    const bodies: object[] = [];
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        now: () => now,
        sleep: async (ms) => { waits.push(ms); now += ms; },
        fetchImpl: (async (_url, init) => {
            bodies.push(init!);
            return rateResponse();
        }) as typeof fetch,
    });
    let factories = 0;
    const result = await scheduler.schedule(request('bounded', {
        makeInit: () => ({ body: JSON.stringify({ attempt: ++factories }) }),
    }));
    assert.equal(result.ok, false);
    assert.equal(factories, 4, 'initial attempt plus three retries');
    assert.equal(new Set(bodies).size, 4);
    assert.deepEqual(waits, [250, 500, 1_000]);

    let cappedNow = 0;
    let cappedCalls = 0;
    const cappedWaits: number[] = [];
    const capped = new DiscordRestScheduler({
        token: 'token',
        now: () => cappedNow,
        maxCumulativeWaitMs: 600,
        sleep: async (ms) => { cappedWaits.push(ms); cappedNow += ms; },
        fetchImpl: (async () => { cappedCalls += 1; return rateResponse(); }) as typeof fetch,
    });
    await capped.schedule(request('capped'));
    assert.equal(cappedCalls, 2);
    assert.deepEqual(cappedWaits, [250]);
});

test('caller abort cancels a pending retry without another fetch', async () => {
    const retryWait = deferred<void>();
    const abort = new AbortController();
    let calls = 0;
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        now: () => 0,
        sleep: async (_ms, signal) => {
            signal.addEventListener('abort', () => retryWait.reject(signal.reason), { once: true });
            return retryWait.promise;
        },
        fetchImpl: (async () => {
            calls += 1;
            return rateResponse({ retryAfter: '1' });
        }) as typeof fetch,
    });
    const pending = scheduler.schedule(request('abort-retry', { signal: abort.signal }));
    await flush();
    abort.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'rate-limit');
    assert.equal(calls, 1);
});

test('two merged pre-discovery 429 responses retry one at a time', async () => {
    const firstA = deferred<Response>();
    const firstB = deferred<Response>();
    const retryGates: Deferred<Response>[] = [];
    let calls = 0;
    let retryOnWire = 0;
    let retryPeak = 0;
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        now: () => 0,
        sleep: async () => {},
        fetchImpl: (async () => {
            calls += 1;
            if (calls === 1) return firstA.promise;
            if (calls === 2) return firstB.promise;
            retryOnWire += 1;
            retryPeak = Math.max(retryPeak, retryOnWire);
            const gate = deferred<Response>();
            retryGates.push(gate);
            try { return await gate.promise; } finally { retryOnWire -= 1; }
        }) as typeof fetch,
    });

    const a = scheduler.schedule(request('merge-429-a', { routeKey: 'POST:/a' }));
    const b = scheduler.schedule(request('merge-429-b', { routeKey: 'POST:/b' }));
    await flush();
    firstA.resolve(rateResponse({ bucket: 'shared', retryAfter: '0' }));
    firstB.resolve(rateResponse({ bucket: 'shared', retryAfter: '0' }));
    await flush();
    assert.equal(retryGates.length, 1);
    retryGates[0]!.resolve(bucketResponse('shared'));
    await flush();
    assert.equal(retryGates.length, 2);
    retryGates[1]!.resolve(bucketResponse('shared'));
    await Promise.all([a, b]);
    assert.equal(retryPeak, 1);
});

test('queued abort, init rejection, queue overflow, and close are proven unsent', async () => {
    const firstGate = deferred<Response>();
    const paths: string[] = [];
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        fetchImpl: (async (url) => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            if (path.endsWith('/first')) return firstGate.promise;
            return new Response(null, { status: 204 });
        }) as typeof fetch,
    });
    const first = scheduler.schedule(request('first', { routeKey: 'POST:/same' }));
    const abort = new AbortController();
    const aborted = scheduler.schedule(request('aborted', { routeKey: 'POST:/same', signal: abort.signal }));
    abort.abort();
    const abortedResult = await Promise.race([
        aborted,
        new Promise<never>((_resolve, reject) => setImmediate(() => reject(new Error('queued abort did not settle')))),
    ]);
    assert.equal(abortedResult.ok, false);
    if (!abortedResult.ok) assert.equal(abortedResult.failure.kind, 'transient');
    assert.equal(paths.some((path) => path.endsWith('/aborted')), false);
    firstGate.resolve(new Response(null, { status: 204 }));
    await first;

    const rejected = scheduler.schedule(request('bad-init', {
        routeKey: 'POST:/init',
        makeInit: () => { throw new Error('factory failed'); },
    }));
    const afterRejected = scheduler.schedule(request('after-init', { routeKey: 'POST:/init' }));
    const rejectedResult = await rejected;
    assert.equal(rejectedResult.ok, false);
    if (!rejectedResult.ok) assert.equal(rejectedResult.failure.kind, 'transient');
    assert.equal((await afterRejected).ok, true, 'the fetch fence stayed locked');

    const overflow = new DiscordRestScheduler({
        token: 'token',
        maxQueue: 1,
        fetchImpl: (async (_url, init) => await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            assert.ok(signal);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })) as typeof fetch,
    });
    const held = overflow.schedule(request('held'));
    const full = await overflow.schedule(request('full'));
    assert.equal(full.ok, false);
    if (!full.ok) assert.equal(full.failure.kind, 'transient');
    overflow.close();
    const closedHeld = await held;
    assert.equal(closedHeld.ok, false);
    if (!closedHeld.ok) assert.equal(closedHeld.failure.kind, 'transient');

    const closeBeforeDispatch = new DiscordRestScheduler({ token: 'token' });
    const queuedBeforeClose = closeBeforeDispatch.schedule(request('closed-before-dispatch'));
    closeBeforeDispatch.close();
    const closedQueued = await queuedBeforeClose;
    assert.equal(closedQueued.ok, false);
    if (!closedQueued.ok) assert.equal(closedQueued.failure.kind, 'transient');
});

test('post-fetch network errors are ambiguous and HTTP failures use the delivery mapper', async () => {
    let networkCalls = 0;
    const network = new DiscordRestScheduler({
        token: 'token',
        fetchImpl: (async () => {
            networkCalls += 1;
            throw new Error('socket hang up');
        }) as typeof fetch,
    });
    const networkResult = await network.schedule(request('network'));
    assert.equal(networkResult.ok, false);
    if (!networkResult.ok) assert.equal(networkResult.failure.kind, 'ambiguous');
    assert.equal(networkCalls, 1);

    const expected = new Map<number, string>([
        [400, 'format'], [401, 'auth'], [403, 'permission'],
        [404, 'not-found'], [413, 'format'],
    ]);
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        fetchImpl: (async (url) => {
            const status = Number(new URL(String(url)).pathname.split('/').at(-1));
            return new Response(JSON.stringify({ message: `status ${status}` }), {
                status,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch,
    });
    for (const [status, kind] of expected) {
        const result = await scheduler.schedule(request(String(status), { majorKey: String(status) }));
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.failure.kind, kind, String(status));
    }
});

test('close aborts an active fetch and drains the canonical queue exactly once', async () => {
    let calls = 0;
    const scheduler = new DiscordRestScheduler({
        token: 'token',
        fetchImpl: (async (_url, init) => {
            calls += 1;
            return await new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                assert.ok(signal);
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        }) as typeof fetch,
    });
    const active = scheduler.schedule(request('active', { routeKey: 'POST:/same' }));
    const queued = scheduler.schedule(request('queued', { routeKey: 'POST:/same' }));
    await flush();
    scheduler.close();
    scheduler.close();
    const [activeResult, queuedResult] = await Promise.all([active, queued]);
    assert.equal(calls, 1);
    assert.equal(activeResult.ok, false);
    assert.equal(queuedResult.ok, false);
    if (!activeResult.ok) assert.equal(activeResult.failure.kind, 'ambiguous');
    if (!queuedResult.ok) assert.equal(queuedResult.failure.kind, 'transient');
});

test('send-only text preserves chunk order across a 429 and token replacement closes the old scheduler', async () => {
    invalidateDiscordSendClient();
    const realFetch = globalThis.fetch;
    const bodies: string[] = [];
    let firstAttempt = true;
    globalThis.fetch = (async (_url, init) => {
        bodies.push(String(init?.body));
        if (firstAttempt) {
            firstAttempt = false;
            return rateResponse({ retryAfter: '0.001' });
        }
        return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        const firstChunk = 'a'.repeat(2_000);
        const result = await sendDiscordTextRest('token-a', 'channel', `${firstChunk}b`);
        assert.equal(result.ok, true);
        assert.deepEqual(bodies.map((body) => JSON.parse(body).content), [firstChunk, firstChunk, 'b']);

        bodies.length = 0;
        await sendDiscordTextRest('token-b', 'channel', 'new token');
        assert.equal(bodies.length, 1);
        assert.match(bodies[0]!, /new token/);
    } finally {
        invalidateDiscordSendClient();
        globalThis.fetch = realFetch;
    }
});

test('send-only token replacement aborts the old scheduler in flight', async () => {
    invalidateDiscordSendClient();
    const realFetch = globalThis.fetch;
    let oldCalls = 0;
    let newCalls = 0;
    globalThis.fetch = (async (_url, init) => {
        const authorization = new Headers(init?.headers).get('authorization');
        if (authorization === 'Bot old-token') {
            oldCalls += 1;
            return await new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                assert.ok(signal);
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        }
        newCalls += 1;
        return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        const oldSend = sendDiscordTextRest('old-token', 'channel', 'old');
        await flush();
        const newSend = sendDiscordTextRest('new-token', 'channel', 'new');
        const [oldResult, newResult] = await Promise.all([oldSend, newSend]);
        assert.equal(oldResult.ok, false);
        if (!oldResult.ok) assert.equal(oldResult.failure.kind, 'ambiguous');
        assert.equal(newResult.ok, true);
        assert.equal(oldCalls, 1);
        assert.equal(newCalls, 1);
    } finally {
        invalidateDiscordSendClient();
        globalThis.fetch = realFetch;
    }
});

test('send-only multipart retries build distinct FormData, Blob, and boundaries', async () => {
    invalidateDiscordSendClient();
    const directory = await mkdtemp(join(tmpdir(), 'cli-jaw-discord-rest-'));
    const filePath = join(directory, 'sample.bin');
    await writeFile(filePath, Buffer.from('fresh multipart body'));
    const realFetch = globalThis.fetch;
    const forms: FormData[] = [];
    globalThis.fetch = (async (_url, init) => {
        assert.ok(init?.body instanceof FormData);
        forms.push(init.body);
        return forms.length === 1
            ? rateResponse({ retryAfter: '0.001' })
            : new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        const result = await sendDiscordFileRest('token', 'channel', filePath, 'caption');
        assert.equal(result.ok, true);
        assert.equal(forms.length, 2);
        assert.notEqual(forms[0], forms[1]);
        assert.notEqual(forms[0]!.get('files[0]'), forms[1]!.get('files[0]'));

        const first = new Request('https://example.test', { method: 'POST', body: forms[0] });
        const second = new Request('https://example.test', { method: 'POST', body: forms[1] });
        const firstType = first.headers.get('content-type');
        const secondType = second.headers.get('content-type');
        assert.match(firstType ?? '', /^multipart\/form-data; boundary=/);
        assert.match(secondType ?? '', /^multipart\/form-data; boundary=/);
        assert.notEqual(firstType, secondType);
    } finally {
        invalidateDiscordSendClient();
        globalThis.fetch = realFetch;
        await rm(directory, { recursive: true, force: true });
    }
});
