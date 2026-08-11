import test from 'node:test';
import assert from 'node:assert/strict';
import { slackApi } from '../../src/slack/api.ts';

function abortAwareFetch(seen: RequestInit[]): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(init || {});
        return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    }) as typeof fetch;
}

async function settleWithin<T>(pending: Promise<T>, timeoutMs = 1_000): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`test operation did not settle within ${timeoutMs}ms`)), timeoutMs);
    });
    try {
        return await Promise.race([pending, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

test('slackApi forwards a caller cancellation signal', async () => {
    const seen: RequestInit[] = [];
    const controller = new AbortController();
    const pending = slackApi('xoxb-test', 'files.info', { file: 'F1' }, {
        fetchImpl: abortAwareFetch(seen), signal: controller.signal, form: true,
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(seen[0]?.signal?.aborted, true);
});

test('slackApi composes timeout and caller cancellation', async () => {
    const seen: RequestInit[] = [];
    const controller = new AbortController();
    const pending = slackApi('xoxb-test', 'files.info', { file: 'F1' }, {
        fetchImpl: abortAwareFetch(seen), signal: controller.signal, timeoutMs: 20, form: true,
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.notEqual(seen[0]?.signal, controller.signal, 'both sources use a composed signal');
    assert.equal(seen[0]?.signal?.aborted, true);
});

test('slackApi timeout alone aborts a stalled request', async () => {
    const seen: RequestInit[] = [];
    const result = await settleWithin(slackApi('xoxb-test', 'files.info', { file: 'F1' }, {
        fetchImpl: abortAwareFetch(seen), timeoutMs: 5, form: true,
    }));
    assert.equal(result.ok, false);
    assert.equal(seen[0]?.signal?.aborted, true);
});
