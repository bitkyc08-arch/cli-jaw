import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchOpenCodeUsage, normalizeOpenCodeGoUsage, readOpenCodeGoApiKey } from '../../src/routes/quota-opencode-go-api.js';

const usageUrl = 'https://opencode.ai/zen/go/v1/usage';
const modelsUrl = 'https://opencode.ai/zen/go/v1/models';
const canonical = { usage: {
    rolling: { percent: 12.5, resetsAt: '2026-09-09T00:00:00Z' },
    weekly: { percent: '8', resetsAt: 1789430400 },
    monthly: { percent: 35, resetsAt: '2026-10-01T00:00:00Z' },
} };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('canonical Go envelope preserves fractional percentages and absolute resets', () => {
    const result = normalizeOpenCodeGoUsage(canonical);
    assert.deepEqual(result.windows, [
        { label: '5h', percent: 12.5, resetsAt: '2026-09-09T00:00:00.000Z' },
        { label: 'Weekly', percent: 8, resetsAt: '2026-09-15T00:00:00.000Z' },
        { label: 'Monthly', percent: 35, resetsAt: '2026-10-01T00:00:00.000Z' },
    ]);
});

test('canonical presence cannot resurrect legacy windows; invalid fields remain unknown', () => {
    const legacy = { weekly: { percent: 99 } };
    assert.deepEqual(normalizeOpenCodeGoUsage({ ...legacy, usage: {} }).windows, []);
    assert.equal(normalizeOpenCodeGoUsage({ ...legacy, usage: [] }).error, true);
    for (const percent of [null, true, '', Infinity, NaN]) {
        assert.deepEqual(normalizeOpenCodeGoUsage({ usage: { rolling: { percent } } }).windows, []);
    }
    assert.deepEqual(normalizeOpenCodeGoUsage({ usage: { rolling: { percent: 150, resetsAt: 1e30 } } }).windows,
        [{ label: '5h', percent: 100, resetsAt: null }]);
});

test('legacy relative resets are bounded and absolute reset wins', t => {
    t.mock.method(Date, 'now', () => Date.parse('2026-09-08T00:00:00Z'));
    for (const resetInSec of [0, -1, 1e30]) {
        const result = normalizeOpenCodeGoUsage({ rolling: { percent: 7, resetInSec } });
        assert.deepEqual(result.windows, [{ label: '5h', percent: 7, resetsAt: resetInSec === 0 ? '2026-09-08T00:00:00.000Z' : null }]);
    }
    assert.deepEqual(normalizeOpenCodeGoUsage({ rolling: { percent: 7, resetInSec: 60, resetsAt: '2026-10-01' } }).windows,
        [{ label: '5h', percent: 7, resetsAt: '2026-10-01T00:00:00.000Z' }]);
});

test('legacy malformed prefix candidates cannot mask later valid objects', () => {
    const result = normalizeOpenCodeGoUsage({
        rolling5h: 'unavailable', rolling: { percent: 17 },
        weekly: [], monthly: false,
        windows: { weekly: { percent: 23 }, monthly: { percent: 41 } },
    });
    assert.deepEqual(result.windows, [
        { label: '5h', percent: 17, resetsAt: null },
        { label: 'Weekly', percent: 23, resetsAt: null },
        { label: 'Monthly', percent: 41, resetsAt: null },
    ]);
    assert.deepEqual(normalizeOpenCodeGoUsage({ usage: {}, rolling: { percent: 17 } }).windows, []);
});

test('default Go reader uses usage first and never probes models on success or valid empty', async t => {
    const old = process.env.OPENCODE_GO_API_KEY;
    process.env.OPENCODE_GO_API_KEY = 'fixture-go-key';
    t.after(() => { if (old === undefined) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = old; });
    const calls: string[] = [];
    let body: unknown = canonical;
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
        calls.push(String(url));
        assert.equal(init?.redirect, 'error');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-go-key');
        assert.equal(String(url), usageUrl);
        return json(body);
    });
    assert.equal((await fetchOpenCodeUsage()).quotaCapable, true);
    body = { usage: {} };
    const empty = await fetchOpenCodeUsage();
    assert.equal(empty.authenticated, true);
    assert.equal(empty.quotaCapable, false);
    assert.deepEqual(calls, [usageUrl, usageUrl]);
    assert.ok(!JSON.stringify(empty).includes('fixture-go-key'));
});

test('Go failure classes preserve auth evidence and bound the models fallback', async t => {
    const old = process.env.OPENCODE_GO_API_KEY;
    process.env.OPENCODE_GO_API_KEY = 'fixture-go-key';
    t.after(() => { if (old === undefined) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = old; });
    let usageStatus = 401;
    let modelStatus = 200;
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
        assert.equal(init?.redirect, 'error');
        calls.push(String(url));
        if (String(url) === usageUrl) return new Response('failure', { status: usageStatus });
        assert.equal(String(url), modelsUrl);
        return modelStatus === 200 ? json({ object: 'list' }) : new Response(null, { status: modelStatus });
    });
    for (const status of [401, 403, 408, 429, 500, 503, 400]) {
        usageStatus = status; calls.length = 0;
        const result = await fetchOpenCodeUsage();
        assert.deepEqual(calls, [usageUrl]);
        assert.deepEqual(result.windows, []);
        if (status === 401 || status === 403) assert.equal(result.authenticated, false);
        else { assert.equal(result.error, true); assert.notEqual(result.authenticated, false); }
    }
    usageStatus = 404;
    for (const status of [200, 401, 429]) {
        modelStatus = status; calls.length = 0;
        const result = await fetchOpenCodeUsage();
        assert.deepEqual(calls, [usageUrl, modelsUrl]);
        assert.equal(result.quotaCapable, false);
        if (status === 200) assert.equal(result.authenticated, true);
        else if (status === 401) assert.equal(result.authenticated, false);
        else assert.notEqual(result.authenticated, false);
    }
});

test('Go malformed and oversized bodies fail without models or secret echo', async t => {
    const old = process.env.OPENCODE_GO_API_KEY;
    process.env.OPENCODE_GO_API_KEY = 'fixture-go-key';
    t.after(() => { if (old === undefined) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = old; });
    let response = new Response('{fixture-go-key', { headers: { 'content-type': 'application/json' } });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url: unknown) => { assert.equal(String(url), usageUrl); calls++; return response; });
    assert.equal((await fetchOpenCodeUsage()).error, true);
    response = new Response('fixture-go-key', { headers: { 'content-type': 'application/json', 'content-length': '524289' } });
    const result = await fetchOpenCodeUsage();
    assert.equal(result.error, true);
    assert.ok(!JSON.stringify(result).includes('fixture-go-key'));
    assert.equal(calls, 2);
});

test('Go key precedence remains env, dedicated file, native auth, settings', t => {
    const old = process.env.OPENCODE_GO_API_KEY;
    t.after(() => { if (old === undefined) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = old; });
    let dedicated = true; let native = true;
    t.mock.method(fs, 'readFileSync', (path: unknown) => {
        const name = String(path).replaceAll('\\', '/');
        if (name.endsWith('opencode-go-api-key')) { if (dedicated) return 'file-key'; throw new Error('absent'); }
        if (name.endsWith('opencode/auth.json')) return JSON.stringify(native ? { 'opencode-go': { key: 'native-key' } } : {});
        if (name.endsWith('settings.json')) return JSON.stringify({ quota: { opencodeGoApiKey: 'settings-key' } });
        throw new Error('Unexpected file');
    });
    process.env.OPENCODE_GO_API_KEY = 'env-key'; assert.equal(readOpenCodeGoApiKey(), 'env-key');
    delete process.env.OPENCODE_GO_API_KEY; assert.equal(readOpenCodeGoApiKey(), 'file-key');
    dedicated = false; assert.equal(readOpenCodeGoApiKey(), 'native-key');
    native = false; assert.equal(readOpenCodeGoApiKey(), 'settings-key');
});
