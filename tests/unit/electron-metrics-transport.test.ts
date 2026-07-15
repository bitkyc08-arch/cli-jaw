import test from 'node:test';
import assert from 'node:assert/strict';
import {
    startAppMetricsCollector,
    type AppMetricsCollectorOptions,
} from '../../electron/src/main/lib/app-metrics.js';

const METRICS_PATH = '/api/dashboard/electron-metrics';
const ELECTRON_HEADER = 'x-cli-jaw-electron';
const RENDERER_TOKEN = 'per-launch-renderer-token';

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((onResolve) => {
        resolve = onResolve;
    });
    return { promise, resolve };
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function sampleAppMetrics() {
    return [
        {
            type: 'Browser',
            name: 'main',
            pid: 100,
            memory: { workingSetSize: 4096 },
            cpu: { percentCPUUsage: 1.25 },
        },
        {
            type: 'Tab',
            name: 'renderer',
            pid: 200,
            memory: { workingSetSize: 8192 },
            cpu: { percentCPUUsage: 0.5 },
        },
    ];
}

function baseOptions(
    fetchImpl: typeof fetch,
    overrides: Partial<AppMetricsCollectorOptions> = {},
): AppMetricsCollectorOptions {
    return {
        sampleAppMetrics,
        now: () => 1_234,
        scheduleTick: () => ({ fakeTimer: true }),
        clearTick: () => {},
        fetchImpl,
        managerUrlProvider: () => 'http://127.0.0.1:24577/',
        tokenProvider: () => RENDERER_TOKEN,
        ...overrides,
    };
}

test('main collector posts the sampled snapshot to the normalized manager route with the per-launch token', async () => {
    const posted = deferred<{ input: RequestInfo | URL; init?: RequestInit }>();
    const collector = startAppMetricsCollector(baseOptions(async (input, init) => {
        posted.resolve({ input, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, {
        managerUrlProvider: () => 'http://127.0.0.1:24577/nested//',
    }));

    const call = await posted.promise;
    await nextTurn();

    assert.equal(String(call.input), `http://127.0.0.1:24577${METRICS_PATH}`);
    assert.equal(call.init?.method, 'POST');
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get(ELECTRON_HEADER), RENDERER_TOKEN);
    assert.notEqual(headers.get(ELECTRON_HEADER), '1', 'the legacy desktop marker must never authenticate metrics');
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
        ts: 1_234,
        rendererCount: 1,
        mainCount: 1,
        rssTotalKb: 12_288,
        processes: [
            { type: 'Browser', name: 'main', pid: 100, rssKb: 4096, cpu: 1.25 },
            { type: 'Tab', name: 'renderer', pid: 200, rssKb: 8192, cpu: 0.5 },
        ],
    });
    assert.equal(collector.snapshot()?.ts, 1_234);
    assert.equal(collector.buffer().length, 1);
    collector.stop();
});

test('a pending POST suppresses duplicate ticks instead of building a queue', async () => {
    let tick!: () => void;
    let sampleCount = 0;
    let fetchCount = 0;
    const fetchStarted = deferred<void>();
    const fetchResult = deferred<Response>();
    const collector = startAppMetricsCollector(baseOptions(async () => {
        fetchCount += 1;
        fetchStarted.resolve();
        return fetchResult.promise;
    }, {
        sampleAppMetrics: () => {
            sampleCount += 1;
            return sampleAppMetrics();
        },
        scheduleTick: (callback) => {
            tick = callback;
            return { fakeTimer: true };
        },
    }));

    await fetchStarted.promise;
    tick();
    tick();
    await nextTurn();

    assert.equal(fetchCount, 1);
    assert.equal(sampleCount, 1);
    assert.equal(collector.buffer().length, 1);

    fetchResult.resolve(new Response(null, { status: 200 }));
    await nextTurn();
    collector.stop();
});

test('a failed POST releases the in-flight gate so the next tick retries', async () => {
    let tick!: () => void;
    let attempts = 0;
    const firstFailure = deferred<void>();
    const secondAttempt = deferred<void>();
    const collector = startAppMetricsCollector(baseOptions(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('manager unavailable');
        secondAttempt.resolve();
        return new Response(null, { status: 200 });
    }, {
        scheduleTick: (callback) => {
            tick = callback;
            return { fakeTimer: true };
        },
        onError: () => firstFailure.resolve(),
    }));

    await firstFailure.promise;
    tick();
    await secondAttempt.promise;
    await nextTurn();

    assert.equal(attempts, 2);
    assert.equal(collector.buffer().length, 2);
    collector.stop();
});

test('stop clears the scheduled handle once, aborts the POST, and makes later ticks inert', async () => {
    let tick!: () => void;
    let sampleCount = 0;
    let scheduledInterval = 0;
    const timerHandle = { fakeTimer: true };
    const cleared: unknown[] = [];
    const fetchStarted = deferred<AbortSignal>();
    const errors: Error[] = [];
    const collector = startAppMetricsCollector(baseOptions((_input, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        fetchStarted.resolve(signal);
        return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
        });
    }, {
        sampleAppMetrics: () => {
            sampleCount += 1;
            return sampleAppMetrics();
        },
        scheduleTick: (callback, intervalMs) => {
            tick = callback;
            scheduledInterval = intervalMs;
            return timerHandle;
        },
        clearTick: (handle) => cleared.push(handle),
        onError: (error) => errors.push(error),
    }));

    const signal = await fetchStarted.promise;
    collector.stop();
    collector.stop();

    assert.equal(scheduledInterval, 5_000);
    assert.deepEqual(cleared, [timerHandle]);
    assert.equal(signal.aborted, true);
    tick();
    await nextTurn();
    assert.equal(sampleCount, 1);
    assert.deepEqual(errors, [], 'stop-triggered abort is an expected lifecycle event, not a transport error');
});
