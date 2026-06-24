import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAdaptiveFetch } from '../../src/browser/adaptive-fetch/scheduler.js';
import { fetchViaCamoufox } from '../../src/browser/adaptive-fetch/camoufox-session.js';
import type { AdaptiveFetchOptions } from '../../src/browser/adaptive-fetch/types.js';

// P0-6: the overall deadline must ABORT an in-flight fetch, not merely skip the
// next stage. A real fetch that hangs until its AbortSignal fires should be
// cancelled at the overall deadline — so executeAdaptiveFetch returns promptly
// instead of blocking on the per-request timeout (much longer) or forever.
test('overall deadline aborts an in-flight fetch (P0-6)', async () => {
    let sawSignal = false;
    let signalAborted = false;
    const hangingFetch = ((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        if (signal) sawSignal = true;
        return new Promise<Response>((_resolve, reject) => {
            if (!signal) return; // would hang forever without a signal — the bug
            signal.addEventListener('abort', () => {
                signalAborted = true;
                reject(new Error('aborted by deadline'));
            }, { once: true });
        });
    }) as unknown as typeof fetch;

    const start = Date.now();
    const result = await executeAdaptiveFetch(
        { url: 'https://example.com/', overallTimeoutMs: 100, browserMode: 'never' } as AdaptiveFetchOptions,
        { fetch: hangingFetch },
    );
    const elapsed = Date.now() - start;

    assert.equal(sawSignal, true, 'fetch must receive an AbortSignal from the scheduler');
    assert.equal(signalAborted, true, 'the in-flight fetch signal must be aborted at the overall deadline');
    assert.ok(elapsed < 5000, `executeAdaptiveFetch returned promptly after the 100ms deadline (was ${elapsed}ms) instead of blocking on the per-request timeout`);
    assert.ok(result && typeof result === 'object', 'returns a final result after deadline abort');
});

test('browser (Camoufox) stage bails immediately when the deadline already fired (P0-6)', async () => {
    // The scheduler threads its deadline signal into the browser stages too; an
    // already-aborted signal must short-circuit before spawning the Camoufox
    // subprocess (proves the browser/CDP path honors the overall deadline).
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await fetchViaCamoufox('https://example.com/', { timeoutMs: 30_000, signal: ctrl.signal });
    assert.equal(result, null);
});

test('a fast fetch is not aborted by a generous deadline', async () => {
    const okFetch = ((_url: string) => Promise.resolve(new Response('<html><body>hello world content</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
    }))) as unknown as typeof fetch;

    const result = await executeAdaptiveFetch(
        { url: 'https://example.com/', overallTimeoutMs: 60_000, browserMode: 'never' } as AdaptiveFetchOptions,
        { fetch: okFetch },
    );
    assert.ok(result && typeof result === 'object', 'returns a result for a fast fetch');
});
