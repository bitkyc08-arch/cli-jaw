import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAdaptiveFetch } from '../../src/browser/adaptive-fetch/scheduler.js';
import { fetchViaCamoufox } from '../../src/browser/adaptive-fetch/camoufox-session.js';
import type { AdaptiveFetchOptions } from '../../src/browser/adaptive-fetch/types.js';

// The scheduler's internal deadline timer is unref()'d (so production code
// doesn't prevent Node from exiting). In an isolated test subprocess (CI,
// isolation:'process') there are no other ref'd handles, so Node exits before
// the unref'd timer fires → "Promise resolution still pending". A ref'd
// keepalive timer prevents this without changing production behavior.

test('overall deadline aborts an in-flight fetch (P0-6)', { timeout: 10_000 }, async () => {
    const keepAlive = setTimeout(() => {}, 10_000);
    try {
        let sawSignal = false;
        let signalAborted = false;
        const hangingFetch = ((_url: string, init?: RequestInit) => {
            const signal = init?.signal;
            if (signal) sawSignal = true;
            return new Promise<Response>((_resolve, reject) => {
                if (!signal) return;
                if (signal.aborted) { signalAborted = true; reject(new Error('aborted by deadline')); return; }
                signal.addEventListener('abort', () => {
                    signalAborted = true;
                    reject(new Error('aborted by deadline'));
                }, { once: true });
            });
        }) as unknown as typeof fetch;

        const start = Date.now();
        const result = await executeAdaptiveFetch(
            { url: 'https://example.com/', overallTimeoutMs: 500, browserMode: 'never' } as AdaptiveFetchOptions,
            { fetch: hangingFetch },
        );
        const elapsed = Date.now() - start;

        assert.equal(sawSignal, true, 'fetch must receive an AbortSignal from the scheduler');
        assert.equal(signalAborted, true, 'the in-flight fetch signal must be aborted at the overall deadline');
        assert.ok(elapsed < 5000, `executeAdaptiveFetch returned promptly after the 500ms deadline (was ${elapsed}ms)`);
        assert.ok(result && typeof result === 'object', 'returns a final result after deadline abort');
    } finally {
        clearTimeout(keepAlive);
    }
});

test('browser (Camoufox) stage bails immediately when the deadline already fired (P0-6)', { timeout: 10_000 }, async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await fetchViaCamoufox('https://example.com/', { timeoutMs: 30_000, signal: ctrl.signal });
    assert.equal(result, null);
});

test('a fast fetch is not aborted by a generous deadline', { timeout: 10_000 }, async () => {
    const keepAlive = setTimeout(() => {}, 10_000);
    try {
        const okFetch = ((_url: string) => Promise.resolve(new Response('<html><body>hello world content</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        }))) as unknown as typeof fetch;

        const result = await executeAdaptiveFetch(
            { url: 'https://example.com/', overallTimeoutMs: 60_000, browserMode: 'never' } as AdaptiveFetchOptions,
            { fetch: okFetch },
        );
        assert.ok(result && typeof result === 'object', 'returns a result for a fast fetch');
    } finally {
        clearTimeout(keepAlive);
    }
});
