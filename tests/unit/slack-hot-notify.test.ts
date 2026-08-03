import test from 'node:test';
import assert from 'node:assert/strict';

import { notifyRunningServer } from '../../src/slack/hot-notify.js';
import { APP_VERSION } from '../../src/core/config.js';

type Call = { url: string; method: string; body?: unknown };

function fakeFetch(handlers: Record<string, { ok: boolean; json?: unknown }>) {
    const calls: Call[] = [];
    const fn = async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        for (const [path, r] of Object.entries(handlers)) {
            if (u.endsWith(path)) {
                return { ok: r.ok, json: async () => r.json } as Response;
            }
        }
        throw new Error('unreachable');
    };
    return { calls, fn: fn as unknown as typeof fetch };
}

test('reloaded: health version matches and PUT carries the slack block', async () => {
    const { calls, fn } = fakeFetch({
        '/api/health': { ok: true, json: { version: APP_VERSION } },
        '/api/settings': { ok: true, json: {} },
    });
    const result = await notifyRunningServer({ enabled: true, botToken: 'xoxb-1' }, fn);
    assert.equal(result, 'reloaded');
    const put = calls.find(c => c.method === 'PUT');
    assert.ok(put, 'PUT /api/settings must be sent');
    assert.deepEqual(put.body, { slack: { enabled: true, botToken: 'xoxb-1' } });
});

test('old-server: version skew means no PUT — the old build has no transport to restart', async () => {
    const { calls, fn } = fakeFetch({
        '/api/health': { ok: true, json: { version: '0.0.1' } },
    });
    const result = await notifyRunningServer({ enabled: true }, fn);
    assert.equal(result, 'old-server');
    assert.equal(calls.some(c => c.method === 'PUT'), false, 'must not merge settings into an old build');
});

test('server-off: connection failure is silent, never throws', async () => {
    const { fn } = fakeFetch({});
    const result = await notifyRunningServer({ enabled: true }, fn);
    assert.equal(result, 'server-off');
});

test('needs-restart: non-ok health or PUT maps to restart guidance', async () => {
    const badHealth = fakeFetch({ '/api/health': { ok: false } });
    assert.equal(await notifyRunningServer({}, badHealth.fn), 'needs-restart');
    const badPut = fakeFetch({
        '/api/health': { ok: true, json: { version: APP_VERSION } },
        '/api/settings': { ok: false },
    });
    assert.equal(await notifyRunningServer({}, badPut.fn), 'needs-restart');
});
