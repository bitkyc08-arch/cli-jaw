import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyClient } from '../../src/core/rate-limit.ts';
import {
    internalFetch,
    JAW_INTERNAL_HEADER,
    withInternalHeader,
} from '../../src/manager/internal-fetch.ts';

test('internalFetch attaches the manager identity header', async () => {
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
        capturedInit = init;
        return new Response();
    }) as typeof fetch;
    try {
        await internalFetch('http://127.0.0.1:3457/api/health');
        assert.equal(new Headers(capturedInit?.headers).get(JAW_INTERNAL_HEADER), '1');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('withInternalHeader preserves existing POST headers', () => {
    const init = withInternalHeader({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
    });
    const headers = new Headers(init.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-request-id'), 'request-1');
    assert.equal(headers.get(JAW_INTERNAL_HEADER), '1');
});

test('withInternalHeader passes method, body, and signal through unchanged', () => {
    const body = JSON.stringify({ prompt: 'hello' });
    const signal = new AbortController().signal;
    const init = withInternalHeader({ method: 'POST', body, signal });
    assert.equal(init.method, 'POST');
    assert.equal(init.body, body);
    assert.equal(init.signal, signal);
});

test('rate limiter classifies a marked loopback request as manager', () => {
    assert.equal(classifyClient({
        ip: '127.0.0.1',
        internalHeader: '1',
        authToken: 'secret',
        lanAllowed: false,
        isPrivateIp: () => false,
    }), 'manager');
});
