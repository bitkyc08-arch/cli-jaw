import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { mock } from 'node:test';

// Never invoke a native CLI or probe the operator's installations.
mock.module('node:child_process', { namedExports: { execFile: (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, 'fixture@example.test', '');
} } });
mock.module('../../src/core/cli-detection.js', { namedExports: { detectCli: () => ({ path: '/fixture/kiro' }) } });
const { fetchKiroUsage, fetchKiroUsageLimits, normalizeKiroUsageLimits } = await import('../../src/routes/quota-kiro-reverse.js');
const { readKiroQuotaAuthFromStore, readKiroAuthFromStore } = await import('../../src/agent/kiro-auth.js');

const usage = { nextDateReset: 1788220800, overageConfiguration: { overageStatus: 'ENABLED' }, usageBreakdownList: [
    { resourceType: 'STORAGE', currentUsage: 99, usageLimit: 100 },
    { resourceType: 'CREDIT', currentUsage: 20, usageLimit: 100 },
    { resourceType: 'AGENTIC_REQUEST', displayName: 'Requests', currentUsage: 99, currentUsageWithPrecision: '100.5', usageLimit: 100,
        freeTrialInfo: { currentUsageWithPrecision: 5, usageLimitWithPrecision: 20 } },
] };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('Kiro selects resource priority, precise values and independent trial/overage', () => {
    const result = normalizeKiroUsageLimits(usage);
    assert.deepEqual(result.windows, [
        { label: 'Requests', percent: 100, resetsAt: '2026-09-01T00:00:00.000Z' },
        { label: 'Free trial', percent: 25, resetsAt: null },
    ]);
    assert.equal(result.currentUsage, 100.5);
    assert.equal(result.usageLimit, 100);
    assert.equal(result.exhausted, false);
    assert.equal(normalizeKiroUsageLimits({ ...usage, overageConfiguration: {} }).exhausted, true);
    const justBelow = { usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: 99.9, usageLimit: 100 }] };
    assert.equal(normalizeKiroUsageLimits(justBelow).exhausted, false);
});

test('Kiro malformed canonical data never becomes fabricated zero or legacy fallback', () => {
    for (const list of [null, {}, [], [null], [{ resourceType: 'STORAGE', currentUsage: 1, usageLimit: 2 }],
        [{ resourceType: 'CREDIT', currentUsage: 1 }], [{ resourceType: 'CREDIT', currentUsage: -1, usageLimit: 2 }],
        [{ resourceType: 'CREDIT', currentUsage: 0, usageLimit: 0 }]]) {
        const result = normalizeKiroUsageLimits({ usageBreakdownList: list, limits: [{ percentUsed: 99 }] });
        assert.deepEqual(result.windows, []);
        assert.equal(result.quotaCapable, false);
        assert.equal(result.currentUsage, undefined);
    }
    assert.deepEqual(normalizeKiroUsageLimits({ limits: [{ percentUsed: '25', type: 'A' }, { currentUsage: 1, totalUsageLimit: 2, type: 'B' }] }).windows,
        [{ label: 'A', percent: 25, resetsAt: null }, { label: 'B', percent: 50, resetsAt: null }]);
});

test('Kiro management request duplicates modeled fields and validates region candidates', async t => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
        calls.push({ url: new URL(input), init });
        return json(usage);
    });
    const results = [
        await fetchKiroUsageLimits('fixture-access', 'arn:aws:service:eu-west-2:acct:profile', { apiRegion: 'us-west-2' }),
        await fetchKiroUsageLimits('fixture-access', 'arn:aws:service:evil.example/x:acct:p', { apiRegion: 'bad/host', ssoRegion: 'eu-west-1' }),
        await fetchKiroUsageLimits('fixture-access', undefined, { apiRegion: 'evil@host', ssoRegion: '..' }),
    ];
    for (const result of results) {
        assert.deepEqual(result, usage);
        assert.equal(normalizeKiroUsageLimits(result).quotaCapable, true);
    }
    for (const { url, init } of calls) {
        const headers = new Headers(init.headers);
        assert.equal(headers.get('authorization'), 'Bearer fixture-access');
        assert.equal(headers.get('x-amzn-codewhisperer-optout'), 'true');
        assert.equal(headers.get('x-amz-target'), 'AmazonCodeWhispererService.GetUsageLimits');
        assert.equal(init.redirect, 'error');
        assert.deepEqual(JSON.parse(String(init.body)), { origin: 'AI_EDITOR', isEmailRequired: true,
            ...(url.searchParams.has('profileArn') ? { profileArn: url.searchParams.get('profileArn') } : {}) });
        assert.equal(url.searchParams.get('origin'), 'AI_EDITOR');
        assert.equal(url.searchParams.get('isEmailRequired'), 'true');
    }
    assert.deepEqual(calls.map(call => call.url.hostname), ['management.eu-west-2.kiro.dev', 'management.eu-west-1.kiro.dev', 'management.us-east-1.kiro.dev']);
});

test('quota-only SQLite supplier preserves old reader and activates optional-profile OIDC', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-kiro-quota-'));
    const file = path.join(dir, 'data.sqlite3');
    const oldDir = process.env.KIRO_CLI_DATA_DIR;
    const oldKey = process.env.KIROCLI_TOKEN_KEY;
    t.after(() => {
        if (oldDir === undefined) delete process.env.KIRO_CLI_DATA_DIR; else process.env.KIRO_CLI_DATA_DIR = oldDir;
        if (oldKey === undefined) delete process.env.KIROCLI_TOKEN_KEY; else process.env.KIROCLI_TOKEN_KEY = oldKey;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    process.env.KIRO_CLI_DATA_DIR = dir; delete process.env.KIROCLI_TOKEN_KEY;
    const db = new Database(file);
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:social:token', JSON.stringify({ accessToken: 'social-fixture' }));
    db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:oidc:token', JSON.stringify({ access_token: 'oidc-fixture', api_region: 'eu-west-1', region: 'us-east-1', refreshToken: 'never-return', clientSecret: 'never-return' }));
    db.close();
    const before = fs.readFileSync(file);
    assert.equal(readKiroAuthFromStore(file).token?.accessToken, 'social-fixture');
    assert.deepEqual(readKiroQuotaAuthFromStore(file).token, { accessToken: 'oidc-fixture', apiRegion: 'eu-west-1', ssoRegion: 'us-east-1' });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
        calls++; assert.equal(new URL(input).hostname, 'management.eu-west-1.kiro.dev');
        assert.equal(new URL(input).searchParams.has('profileArn'), false);
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer oidc-fixture');
        return json(usage);
    });
    const result = await fetchKiroUsage();
    assert.equal(result.quotaCapable, true); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes('oidc-fixture'));
    assert.deepEqual(fs.readFileSync(file), before);
    process.env.KIROCLI_TOKEN_KEY = 'kirocli:social:token';
    assert.equal(readKiroQuotaAuthFromStore(file).token?.accessToken, 'social-fixture');
    process.env.KIROCLI_TOKEN_KEY = 'absent';
    assert.equal(readKiroQuotaAuthFromStore(file).reason, 'kiro_token_key_missing');
    const missing = await fetchKiroUsage();
    assert.equal(missing.authenticated, false); assert.equal(calls, 1);
});

test('quota SQLite selection handles aliases, sole/ambiguous unknowns and malformed selected token', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-kiro-selection-'));
    const file = path.join(dir, 'data.sqlite3');
    const old = process.env.KIROCLI_TOKEN_KEY; delete process.env.KIROCLI_TOKEN_KEY;
    const db = new Database(file);
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); if (old !== undefined) process.env.KIROCLI_TOKEN_KEY = old; });
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)');
    const put = db.prepare('INSERT OR REPLACE INTO auth_kv VALUES (?, ?)');
    put.run('custom:token', JSON.stringify({ accessToken: 'sole', profile_arn: 'token-profile' }));
    db.prepare('INSERT INTO state VALUES (?, ?)').run('api.codewhisperer.profile', JSON.stringify({ profile_arn: 'state-profile', name: 'Fixture' }));
    assert.equal(readKiroQuotaAuthFromStore(file).token?.accessToken, 'sole');
    assert.equal(readKiroQuotaAuthFromStore(file).profile?.arn, 'state-profile');
    db.prepare('UPDATE state SET value = ?').run('{invalid-profile');
    assert.deepEqual(readKiroQuotaAuthFromStore(file), {
        token: { accessToken: 'sole', profileArn: 'token-profile' }, profile: null,
    });
    put.run('kirocli:oidc:token', JSON.stringify({ accessToken: 'valid-oidc', apiRegion: 'eu-west-1' }));
    assert.deepEqual(readKiroQuotaAuthFromStore(file), {
        token: { accessToken: 'valid-oidc', apiRegion: 'eu-west-1' }, profile: null,
    });
    db.prepare('DELETE FROM auth_kv WHERE key = ?').run('kirocli:oidc:token');
    put.run('other:token', JSON.stringify({ accessToken: 'other' }));
    assert.equal(readKiroQuotaAuthFromStore(file).reason, 'kiro_token_ambiguous');
    put.run('kirocli:odic:token', '{}');
    assert.equal(readKiroQuotaAuthFromStore(file).reason, 'kiro_token_invalid');
});

test('Kiro transport/body failures are bounded generic outcomes', async t => {
    let response = new Response(null, { status: 401 });
    t.mock.method(globalThis, 'fetch', async () => response);
    for (const status of [401, 403, 429, 503]) {
        response = new Response('fixture-secret', { status });
        const result = await fetchKiroUsageLimits('fixture-access');
        assert.equal((result as Record<string, unknown>)[status < 429 ? 'authenticated' : 'error'], status < 429 ? false : true);
        assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    }
    response = new Response('{fixture-secret');
    assert.equal((await fetchKiroUsageLimits('fixture-access') as Record<string, unknown>).error, true);
    response = new Response('x', { headers: { 'content-length': '524289' } });
    assert.equal((await fetchKiroUsageLimits('fixture-access') as Record<string, unknown>).error, true);
});
