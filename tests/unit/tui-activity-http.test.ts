import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityHttpRead } from '../../bin/commands/tui/activity-http.js';

const ctx = { apiUrl: 'http://127.0.0.1:1' };
const path = '/api/traces/tr_owned/activity?session=chat&after=0&limit=40';
test('Activity HTTP allows only owned GET paths, rejects redirects and combines caller cancellation', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const controller = new AbortController();
    globalThis.fetch = async (url, init) => {
        calls++;
        assert.equal(url, ctx.apiUrl + path);
        assert.equal(init?.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal);
        return Response.json({ ok: true, data: { events: [] } });
    };
    try {
        for (const bad of ['https://foreign.test/', '//foreign.test/api/traces', '/api/settings',
            '/api/traces/tr_owned/activity?evil=x', '/api/traces/tr_owned/activity?session=a&session=b',
            '/api/traces/../settings', '/api/traces/a\\b/activity', path + '#fragment']) {
            await assert.rejects(activityHttpRead(ctx)(bad, controller.signal));
        }
        assert.equal(calls, 0);
        assert.deepEqual(await activityHttpRead(ctx)(path, controller.signal), { ok: true, data: { events: [] } });
        controller.abort();
        await assert.rejects(activityHttpRead(ctx)(path, controller.signal));
        assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
});

test('Activity HTTP rejects HTTP, content type, declared size, invalid UTF8 and JSON rather than empty success', async () => {
    const original = globalThis.fetch;
    try {
        for (const response of [Response.json({}, { status: 503 }), new Response('text'),
            new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '270001' } }),
            new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
            new Response('{', { headers: { 'content-type': 'application/json' } })]) {
            globalThis.fetch = async () => response;
            await assert.rejects(activityHttpRead(ctx)(path, new AbortController().signal));
        }
    } finally { globalThis.fetch = original; }
});

test('chunked bytes are bounded before JSON parsing and aborted bodies cannot publish', async () => {
    const original = globalThis.fetch;
    let cancelled = false;
    try {
        globalThis.fetch = async () => new Response(new ReadableStream({ start(c) {
            c.enqueue(new Uint8Array(270_001));
        }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
        await assert.rejects(activityHttpRead(ctx)(path, new AbortController().signal), /response_limit/);
        assert.equal(cancelled, true);
        const controller = new AbortController();
        globalThis.fetch = async () => { controller.abort(); return Response.json({ secret: 'late' }); };
        await assert.rejects(activityHttpRead(ctx)(path, controller.signal));
    } finally { globalThis.fetch = original; }
});
