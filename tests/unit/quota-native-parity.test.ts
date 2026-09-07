import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseClaudeUsageWindows as claude, parseCodexUsageWindows as codex } from '../../src/routes/quota-native-window.ts';
import { fetchClaudeUsage, fetchCodexUsage, getCodexCredentialsPath, readCodexTokens } from '../../src/routes/quota.ts';

// Synthetic fixtures derived from the window assignments in OpenCodex
// b94051fe91e745806102988f6dff2fec8de078ef; no native credential or live HTTP reads.
const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_URL = 'https://chatgpt.com/backend-api/wham/usage';
const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => { throw new Error('Unexpected unmocked quota request'); }; });
afterEach(() => { globalThis.fetch = originalFetch; });
const bar = (label: string, percent: number, resetsAt: string | null = null) => ({ label, percent, resetsAt });
const wham = (primary: unknown, secondary?: unknown, tertiary?: unknown) => ({
    rate_limit: { primary_window: primary, secondary_window: secondary, tertiary_window: tertiary },
});
const window = (used_percent: unknown, limit_window_seconds?: number) => ({ used_percent, limit_window_seconds });
const usage = (utilization = 12.5) => ({ five_hour: { utilization }, extra: { compatibility: 'raw-fixture' } });
function clock(t: TestContext) {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    return { advance: (ms: number) => { now += ms; } };
}
function fakeFetch(t: TestContext, reply: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response | Promise<Response>) {
    return t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => reply(input, init));
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test('N01–N04: Codex classifies short, weekly, monthly and tertiary windows', () => {
    const cases = [
        { input: wham(window(97, 18000), window(12, 604800)), expected: [bar('5-hour', 97), bar('7-day', 12)] },
        { input: wham(window(80, 604800)), expected: [bar('7-day', 80)] },
        { input: wham(window(40), window(20)), expected: [bar('7-day', 40)] },
        { input: wham(window(39, 2628000), window(12), window(99)), expected: [bar('7-day', 12), bar('30-day', 39)] },
        { input: wham(window(undefined, 2628000), undefined, window(30)), expected: [bar('30-day', 30)] },
        { input: wham(null, null, window(30)), expected: [bar('30-day', 30)] },
        { input: wham(window(undefined), window(14)), expected: [bar('7-day', 14)] },
    ];
    for (const { input, expected } of cases) assert.deepEqual(codex(input), { windows: expected });
});

test('N05: Go/Free suppress weekly without guessing a monthly primary', () => {
    for (const plan_type of ['go', ' Free ', 'GO']) {
        assert.deepEqual(codex({ ...wham(window(8, 2628000), window(20)), plan_type }), { windows: [bar('30-day', 8)] });
        assert.deepEqual(codex({ ...wham(window(9), window(20), window(30)), plan_type }), { windows: [bar('30-day', 30)] });
        assert.equal(codex({ ...wham(window(9)), plan_type }), null);
    }
    for (const plan_type of [undefined, null, 'unknown-plan', 42]) {
        assert.deepEqual(codex({ ...wham(window(9)), plan_type }), { windows: [bar('7-day', 9)] });
    }
});

test('N06: Codex duration boundary and actual short-window labels', () => {
    for (const [seconds, label] of [[900, '15-minute'], [86399, '86399-second'], [86400, '7-day'], [2419199, '7-day'], [2419200, '30-day']] as const) {
        assert.deepEqual(codex(wham(window(6, seconds))), { windows: [bar(label, 6)] });
    }
    for (const limit_window_seconds of ['18000', 0, -1, Infinity, NaN]) {
        assert.deepEqual(codex(wham({ used_percent: 6, limit_window_seconds })), { windows: [bar('7-day', 6)] });
    }
});

test('N07: known short shape with missing usage never becomes a zero bar', () => {
    const primary = { limit_window_seconds: 18000, reset_at: 2_000_000_000 };
    assert.equal(codex(wham(primary)), null);
    assert.deepEqual(codex(wham(primary, window(17))), { windows: [bar('7-day', 17)] });
});

test('N08: only Spark weekly additional limit is selected, including additional-only responses', () => {
    const spark = (rate_limit: unknown) => ({ metered_feature: 'codex_bengalfox', rate_limit });
    const additional = (entry: unknown) => ({ additional_rate_limits: [null, {}, entry] });
    assert.deepEqual(codex(additional(spark({ primary_window: window(99, 18000), secondary_window: window(42, 604800) }))), {
        windows: [bar('GPT-5.3-Codex-Spark Weekly', 42)],
    });
    assert.deepEqual(codex(additional({ limit_name: 'GPT-5.3-Codex-Spark', rate_limit: { primary_window: window(12) } })), {
        windows: [bar('GPT-5.3-Codex-Spark Weekly', 12)],
    });
    for (const seconds of [18000, 2628000, '604800', Infinity, 0]) {
        assert.equal(codex(additional(spark({ primary_window: { used_percent: 90, limit_window_seconds: seconds } }))), null);
    }
    assert.equal(codex(additional({ limit_name: 'other', rate_limit: { primary_window: window(12) } })), null);
    assert.equal(codex({ additional_rate_limits: [spark({}), spark({ primary_window: window(12) })] }), null);
});

test('N09: reset credits are finite nonnegative count data, including zero', () => {
    for (const available_count of [0, 3]) {
        assert.deepEqual(codex({ rate_limit_reset_credits: { available_count } }), { windows: [], resetCredits: available_count });
    }
    for (const available_count of [-1, Infinity, NaN, '3', null]) {
        assert.equal(codex({ rate_limit_reset_credits: { available_count } }), null);
    }
});

test('N10: both parsers retain decimals/zero and omit missing or invalid percentages', () => {
    for (const [value, expected] of [['37.6', 37.6], [0, 0], [-5, 0], [150, 100]] as const) {
        assert.deepEqual(codex(wham(window(value))), { windows: [bar('7-day', expected)] });
        assert.deepEqual(claude({ five_hour: { utilization: value } }), { windows: [bar('5-hour', expected)] });
    }
    for (const value of [undefined, null, '', ' ', 'NaN', 'Infinity', NaN, Infinity, [], {}, true]) {
        assert.equal(codex(wham(window(value))), null);
        assert.equal(claude({ five_hour: { utilization: value } }), null);
    }
});

test('N11: reset units and Date bounds preserve valid usage independently', () => {
    const expected = '2033-05-18T03:33:20.000Z';
    for (const reset of [2_000_000_000, '2000000000']) {
        assert.deepEqual(codex(wham({ used_percent: 10, reset_at: reset })), { windows: [bar('7-day', 10, expected)] });
    }
    for (const reset of [2_000_000_000, '2000000000', 2_000_000_000_000, '2000000000000', expected]) {
        assert.deepEqual(claude({ five_hour: { utilization: 10, resets_at: reset } }), { windows: [bar('5-hour', 10, expected)] });
    }
    // Codex never reinterprets a seconds wire value as milliseconds.
    assert.deepEqual(codex(wham({ used_percent: 10, reset_at: 10_000_000_001 })), {
        windows: [bar('7-day', 10, '2286-11-20T17:46:41.000Z')],
    });
    assert.deepEqual(claude({ five_hour: { utilization: 10, resets_at: 10_000_000_001 } }), {
        windows: [bar('5-hour', 10, '1970-04-26T17:46:40.001Z')],
    });
    for (const reset of [0, -1, 1e30, 'invalid-date', null, Infinity]) {
        assert.deepEqual(codex(wham({ used_percent: 10, reset_at: reset })), { windows: [bar('7-day', 10)] });
        assert.deepEqual(claude({ five_hour: { utilization: 10, resets_at: reset } }), { windows: [bar('5-hour', 10)] });
    }
});

const scoped = (name: string, percent: unknown, kind = 'weekly_scoped') => ({ kind, percent, scope: { model: { display_name: name } } });
test('N12: Claude canonical buckets retain labels/order and override model-scoped duplicates', () => {
    assert.deepEqual(claude({
        five_hour: { utilization: 1 }, seven_day: { utilization: 2 },
        seven_day_sonnet: { utilization: 3 }, seven_day_opus: { utilization: 4 }, seven_day_fable: { utilization: 5.5 },
        limits: [scoped('Claude Fable 5', 90), scoped('OPUS', 91), scoped('Sonnet', 92)],
    }), { windows: [bar('5-hour', 1), bar('7-day', 2), bar('7-day Sonnet', 3), bar('7-day Opus', 4), bar('7-day Fable', 5.5)] });
});

test('N13: limits-only supports model scopes, case-insensitive dedupe, and ignores aggregate scopes', () => {
    assert.deepEqual(claude({ limits: [scoped('Claude Fable 5', '33.4'), scoped('fable', 99), scoped('New Model', 20),
        scoped('new model', 80), scoped('ignored', 100, 'session'), scoped('ignored', 100, 'weekly_all'),
        scoped('', 12), scoped('invalid', null), null] }), {
        windows: [bar('7-day Fable', 33.4), bar('7-day New Model', 20)],
    });
    assert.equal(claude({ limits: [scoped('ignored', 100, 'session'), scoped('ignored', 100, 'weekly_all')] }), null);
    assert.deepEqual(claude({ seven_day_fable: { utilization: null }, limits: [scoped('Fable', 7)] }), { windows: [bar('7-day Fable', 7)] });
});

test('N14: malformed shapes do not throw or produce a successful empty snapshot', () => {
    for (const payload of [null, [], 1, 'x', {}, { rate_limit: [] }, { additional_rate_limits: 'bad' },
        { five_hour: [], limits: 'bad' }, { five_hour: { resets_at: '2033-05-18T03:33:20Z' } }]) {
        assert.equal(codex(payload), null);
        assert.equal(claude(payload), null);
    }
});

test('N15: native fetch options, account metadata, decimals and raw compatibility', async t => {
    const cBody = usage();
    const xBody = { rate_limit: { primary_window: { used_percent: 33.4 } }, email: 'fixture@example.invalid', plan_type: 'team', extra: 'raw-marker' };
    const mocked = fakeFetch(t, input => Response.json(String(input) === CLAUDE_URL ? cBody : xBody));
    const token = 'fixture-native-n15';
    const c = await fetchClaudeUsage({ token, account: { type: 'max' } });
    const x = await fetchCodexUsage({ access_token: token, account_id: 'fixture-account' });
    assert.deepEqual(c, { windows: [bar('5-hour', 12.5)], raw: cBody, account: { type: 'max' } });
    assert.deepEqual(x, { windows: [bar('7-day', 33.4)], raw: xBody, account: { email: 'fixture@example.invalid', plan: 'team' } });
    assert.equal(mocked.mock.callCount(), 2);
    for (const [index, url] of [CLAUDE_URL, CODEX_URL].entries()) {
        const [input, init] = mocked.mock.calls[index]!.arguments;
        assert.equal(String(input), url);
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    }
    const cHeaders = new Headers(mocked.mock.calls[0]!.arguments[1]?.headers);
    assert.equal(cHeaders.get('accept'), 'application/json, text/plain, */*');
    assert.equal(cHeaders.get('content-type'), 'application/json');
    assert.equal(cHeaders.get('user-agent'), 'claude-cli/2.1.63 (external, cli)');
    assert.equal(cHeaders.get('anthropic-beta'), 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05');
    assert.equal(new Headers(mocked.mock.calls[1]!.arguments[1]?.headers).get('chatgpt-account-id'), 'fixture-account');
    assert.ok(!JSON.stringify([c, x]).includes(token));
    assert.ok(!JSON.stringify([c, x]).includes(createHash('sha256').update(token).digest('hex')));
});

test('N16/N17: fresh TTL, same-identity fallback and exact expiration without timestamp renewal', async t => {
    const time = clock(t);
    let status = 200;
    const mocked = fakeFetch(t, () => status === 200 ? Response.json(usage(42)) : new Response(null, { status }));
    const a = { token: 'fixture-native-n16-a', account: { type: 'A' } };
    const b = { token: 'fixture-native-n16-b', account: { type: 'B' } };
    await fetchClaudeUsage(a);
    time.advance(29_999);
    const fresh = await fetchClaudeUsage(a);
    assert.ok(fresh && 'cached' in fresh && fresh.cached);
    assert.equal(mocked.mock.callCount(), 1);
    status = 429;
    assert.deepEqual(await fetchClaudeUsage(b), { error: true, reason: 'rate_limited', windows: [], account: b.account });
    time.advance(1);
    const fallback = await fetchClaudeUsage(a);
    assert.deepEqual(fallback, { windows: [bar('5-hour', 42)], raw: usage(42), account: a.account, cached: true });
    assert.equal(mocked.mock.callCount(), 3);
    time.advance(269_999);
    assert.deepEqual(await fetchClaudeUsage(a), fallback);
    time.advance(1);
    assert.deepEqual(await fetchClaudeUsage(a), { error: true, reason: 'rate_limited', windows: [], account: a.account });
    assert.equal(mocked.mock.callCount(), 5);
});

test('N18: concurrent callers join same token, retain caller metadata, and isolate another token', async t => {
    const aResponse = deferred<Response>();
    const bResponse = deferred<Response>();
    const a = { token: 'fixture-native-n18-a', account: { type: 'A1' } };
    const mocked = fakeFetch(t, (_input, init) => new Headers(init?.headers).get('authorization') === `Bearer ${a.token}` ? aResponse.promise : bResponse.promise);
    const first = fetchClaudeUsage(a);
    const joined = fetchClaudeUsage({ ...a, account: { type: 'A2' } });
    const other = fetchClaudeUsage({ token: 'fixture-native-n18-b', account: { type: 'B' } });
    assert.equal(mocked.mock.callCount(), 2);
    bResponse.resolve(Response.json(usage(80)));
    assert.deepEqual(await other, { windows: [bar('5-hour', 80)], raw: usage(80), account: { type: 'B' } });
    aResponse.resolve(Response.json(usage(10)));
    assert.deepEqual(await first, { windows: [bar('5-hour', 10)], raw: usage(10), account: { type: 'A1' } });
    assert.deepEqual(await joined, { windows: [bar('5-hour', 10)], raw: usage(10), account: { type: 'A2' } });
});

test('N19: caller mutation cannot poison cache or another joined response', async t => {
    const response = deferred<Response>();
    const mocked = fakeFetch(t, () => response.promise);
    const creds = { token: 'fixture-native-n19-clone', account: { type: 'max' } };
    const p1 = fetchClaudeUsage(creds);
    const p2 = fetchClaudeUsage(creds);
    response.resolve(Response.json(usage(11)));
    const first = await p1;
    assert.ok(first && 'raw' in first);
    first.windows[0]!.percent = 99;
    (first.raw as { extra: { compatibility: string } }).extra.compatibility = 'mutated';
    assert.deepEqual(await p2, { windows: [bar('5-hour', 11)], raw: usage(11), account: creds.account });
    assert.deepEqual(await fetchClaudeUsage(creds), { windows: [bar('5-hour', 11)], raw: usage(11), account: creds.account, cached: true });
    assert.equal(mocked.mock.callCount(), 1);
});

test('N19/N24: malformed response and network failure clear inflight and permit retry', async t => {
    for (const kind of ['malformed', 'network', 'empty-schema'] as const) {
        let good = false;
        const mocked = fakeFetch(t, () => {
            if (good) return Response.json(usage());
            if (kind === 'network') throw new Error('fixture transport failure');
            return kind === 'malformed' ? new Response('{bad') : Response.json({});
        });
        const creds = { token: `fixture-native-n24-${kind}` };
        assert.deepEqual(await fetchClaudeUsage(creds), { error: true });
        good = true;
        const result = await fetchClaudeUsage(creds);
        assert.ok(result && 'raw' in result);
        assert.equal(mocked.mock.callCount(), 2);
        mocked.mock.restore();
    }
    const mocked = fakeFetch(t, () => new Response('{bad'));
    assert.deepEqual(await fetchCodexUsage({ access_token: 'fixture-native-n24-codex' }), { error: true });
    assert.equal(mocked.mock.callCount(), 1);
});

test('N20: explicit auth errors invalidate same-token fallback', async t => {
    const time = clock(t);
    for (const authStatus of [401, 403]) {
        let status = 200;
        const mocked = fakeFetch(t, () => status === 200 ? Response.json(usage()) : new Response(null, { status }));
        const creds = { token: `fixture-native-n20-${authStatus}` };
        await fetchClaudeUsage(creds);
        time.advance(30_000);
        status = authStatus;
        assert.deepEqual(await fetchClaudeUsage(creds), { authenticated: false });
        status = 429;
        assert.deepEqual(await fetchClaudeUsage(creds), { error: true, reason: 'rate_limited', windows: [], account: undefined });
        assert.equal(mocked.mock.callCount(), 3);
        mocked.mock.restore();
    }
});

test('N21: absent credentials and unsupported Claude auth never make a request', async t => {
    const mocked = fakeFetch(t, () => { throw new Error('must not fetch'); });
    for (const creds of [null, undefined, {}, { token: '' }, { token: ' ' }]) assert.equal(await fetchClaudeUsage(creds), null);
    for (const tokens of [null, undefined, {}, { access_token: '' }, { access_token: ' ' }]) assert.equal(await fetchCodexUsage(tokens), null);
    assert.deepEqual(await fetchClaudeUsage({ quotaCapable: false, source: 'api-key-env', account: { type: 'api-key' } }), {
        authenticated: true, source: 'api-key-env', account: { type: 'api-key' }, windows: [],
    });
    assert.equal(mocked.mock.callCount(), 0);
});

test('N22: CODEX_HOME path resolution uses native path-expand semantics', () => {
    const home = path.resolve('fixture-home');
    assert.equal(getCodexCredentialsPath('', home), path.join(home, '.codex/auth.json'));
    assert.equal(getCodexCredentialsPath('  ', home), path.join(home, '.codex/auth.json'));
    assert.equal(getCodexCredentialsPath('~/custom', home), path.join(home, 'custom/auth.json'));
    assert.equal(getCodexCredentialsPath('relative-codex', home), path.resolve('relative-codex/auth.json'));
    assert.equal(getCodexCredentialsPath(path.join(home, 'absolute'), home), path.join(home, 'absolute/auth.json'));
});

test('N22: Codex reads only selected synthetic auth file and never logs parse excerpts', t => {
    const previousHome = process.env.CODEX_HOME;
    const expected = path.resolve('fixture-codex-home/auth.json');
    process.env.CODEX_HOME = path.dirname(expected);
    let raw = JSON.stringify({ tokens: { access_token: 'fixture-native-discovery', account_id: 'fixture-account' } });
    let missing = false;
    const read = t.mock.method(fs, 'readFileSync', (file: unknown) => {
        assert.equal(file, expected);
        if (missing) throw new Error('fixture missing');
        return raw;
    });
    const debug = t.mock.method(console, 'debug', () => undefined);
    t.mock.method(os, 'homedir', () => path.resolve('fixture-unused-home'));
    try {
        assert.deepEqual(readCodexTokens(), { access_token: 'fixture-native-discovery', account_id: 'fixture-account' });
        for (const tokens of [{ access_token: ' ' }, { access_token: 123 }, { account_id: 'id' }]) {
            raw = JSON.stringify({ tokens });
            assert.equal(readCodexTokens(), null);
        }
        raw = JSON.stringify({ tokens: { access_token: 'fixture-valid', account_id: 22 } });
        assert.deepEqual(readCodexTokens(), { access_token: 'fixture-valid', account_id: '' });
        raw = '{fixture-invalid-json';
        assert.equal(readCodexTokens(), null);
        missing = true;
        assert.equal(readCodexTokens(), null);
        assert.equal(read.mock.callCount(), 7);
        for (const call of read.mock.calls) assert.equal(call.arguments[0], expected);
        assert.equal(debug.mock.callCount(), 0);
    } finally {
        if (previousHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousHome;
    }
});

test('N23: completed Claude cache retains at most sixteen identities', async t => {
    const time = clock(t);
    time.advance(600_000);
    let status = 200;
    const mocked = fakeFetch(t, () => status === 200 ? Response.json(usage()) : new Response(null, { status }));
    for (let i = 0; i < 17; i++) await fetchClaudeUsage({ token: `fixture-native-n23-${i}` });
    time.advance(30_000);
    status = 429;
    assert.deepEqual(await fetchClaudeUsage({ token: 'fixture-native-n23-0' }), {
        error: true, reason: 'rate_limited', windows: [], account: undefined,
    });
    const retained = await fetchClaudeUsage({ token: 'fixture-native-n23-16' });
    assert.ok(retained && 'cached' in retained && retained.cached);
    assert.equal(mocked.mock.callCount(), 19);
});
