import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

type Window = { label: string; percent: number; resetsAt: string | null };

test('Cursor native quota, credential precedence and cookie compatibility', async (t) => {
    const originalFetch = globalThis.fetch;
    const oldSession = process.env['CURSOR_SESSION_TOKEN'];
    const oldDashboard = process.env['CURSOR_DASHBOARD_SESSION_TOKEN'];
    const oldKey = process.env['CURSOR_API_KEY'];
    const oldAuth = process.env['CURSOR_AUTH_TOKEN'];
    const oldStore = process.env['AGENT_CLI_CREDENTIAL_STORE'];
    let keychainStderr = 'password: \"fixture-keychain\"';
    let cliAuthenticated = false;
    let keychainCalls = 0;
    let keychainError: Error | undefined;
    const cliCalls: Array<{ binary: string; args: string[]; options: Record<string, unknown> }> = [];
    const fixtureExec = Object.assign(() => { throw new Error('unexpected sync fixture call'); }, {
        [promisify.custom]: async (_binary: string, args: string[], options: Record<string, unknown>) => {
            assert.ok(_binary === '/usr/bin/security' || _binary === 'fixture-cursor');
            cliCalls.push({ binary: _binary, args, options });
            if (_binary === '/usr/bin/security') {
                keychainCalls += 1;
                if (keychainError) throw keychainError;
            }
            return { stdout: _binary === '/usr/bin/security' ? '' : JSON.stringify(args[0] === 'status' ? { isAuthenticated: cliAuthenticated } : {}),
            stderr: _binary === '/usr/bin/security' ? keychainStderr : '',
            };
        },
    });
    t.mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fixtureExec } });
    process.env['CURSOR_SESSION_TOKEN'] = 'fixture-cookie';
    delete process.env['CURSOR_DASHBOARD_SESSION_TOKEN'];
    delete process.env['CURSOR_API_KEY'];
    delete process.env['CURSOR_AUTH_TOKEN'];
    process.env['AGENT_CLI_CREDENTIAL_STORE'] = 'memory';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let response: () => Response = () => Response.json({});
    globalThis.fetch = (async (input, init) => {
        calls.push({ url: String(input), init }); return response();
    }) as typeof fetch;
    try {
        const { normalizeCursorUsageSummary, fetchCursorDashboardUsage, fetchCursorUsage,
            readCursorNativeAccessToken, getCursorNativeAuthPath, normalizeCursorPeriodUsage,
            normalizeCursorAuthUsage, normalizeCursorNativeSummary, readCursorDashboardSessionToken } =
            await import('../../src/routes/quota-cursor-dashboard.ts');
        const summarize = (plan: Record<string, unknown>, end: unknown = '1771077734000') =>
            normalizeCursorUsageSummary({ individualUsage: { plan }, billingCycleEnd: end });
        await t.test('total precedence, finite strings, derived total and compatible pools', () => {
            assert.deepEqual(summarize({ totalPercentUsed: '15.48', used: 90, limit: 100,
                apiPercentUsed: 46.444, autoPercentUsed: 12 }).windows, [
                { label: 'Cycle', percent: 15.48, resetsAt: new Date(1771077734000).toISOString() },
                { label: 'Auto', percent: 12, resetsAt: new Date(1771077734000).toISOString() },
            ]);
            assert.equal((summarize({ used: '42', limit: '100' }).windows as Window[])[0]!.percent, 42);
            assert.deepEqual(summarize({ used: 0, limit: 0, autoPercentUsed: 0 }).windows, []);
            assert.deepEqual(summarize({ apiPercentUsed: 150 }, 'bad-date').windows,
                [{ label: 'API', percent: 100, resetsAt: null }]);
            assert.deepEqual(summarize({ totalPercentUsed: -1 }, 1e20).windows,
                [{ label: 'Cycle', percent: 0, resetsAt: null }]);
            const clean = summarize({ used: { secret: 'fixture-private' }, limit: [], remaining: false });
            assert.ok(!JSON.stringify(clean).includes('fixture-private'));
            assert.equal(clean.planUsed, undefined);
        });
        await t.test('successful dashboard proves auth despite failed CLI probe', async () => {
            response = () => Response.json({ individualUsage: { plan: { totalPercentUsed: 25 } } });
            const result = await fetchCursorUsage('fixture-cursor');
            assert.equal(result.authenticated, true);
            assert.equal(result.quotaCapable, true);
            const call = calls.at(-1)!;
            assert.equal(call.url, 'https://cursor.com/api/usage-summary');
            assert.equal(call.init?.method ?? 'GET', 'GET');
            assert.equal(call.init?.redirect, 'error');
            assert.ok(call.init?.signal);
            const headers = new Headers(call.init?.headers);
            assert.equal(headers.get('cookie'), 'WorkosCursorSessionToken=fixture-cookie');
            assert.equal(headers.get('accept'), 'application/json');
            assert.equal(headers.get('authorization'), null);
            assert.ok(!JSON.stringify(result).includes('fixture-cookie'));
        });
        for (const status of [401, 403]) await t.test(`expired cookie ${status} keeps native status`, async () => {
            cliAuthenticated = true;
            response = () => new Response('', { status });
            const result = await fetchCursorUsage('fixture-cursor');
            assert.equal(result.authenticated, true);
            assert.equal(result.dashboardAuth, false);
            assert.equal(result.quotaCapable, false);
        });
        for (const malformed of [null, [], true]) await t.test(`invalid root ${JSON.stringify(malformed)}`, async () => {
            response = () => Response.json(malformed);
            assert.deepEqual(await fetchCursorDashboardUsage('fixture-cookie'), { error: true });
        });
        for (const kind of ['503', 'malformed', 'oversize', 'throw'] as const) await t.test(kind, async () => {
            response = () => {
                if (kind === '503') return new Response('', { status: 503 });
                if (kind === 'malformed') return new Response('{');
                if (kind === 'oversize') return new Response('{}', { headers: { 'content-length': String(512 * 1024 + 1) } });
                throw new Error('fixture failure');
            };
            const result = await fetchCursorUsage('fixture-cursor');
            assert.equal(result.reason, 'dashboard_fetch_failed');
            assert.equal(result.error, true);
        });
        assert.ok(calls.every(call => call.url === 'https://cursor.com/api/usage-summary'));
        await t.test('native platform paths and selected store only', async () => {
            assert.equal(getCursorNativeAuthPath('darwin', '/fixture/home', {}), '/fixture/home/.cursor/auth.json');
            assert.equal(getCursorNativeAuthPath('linux', '/fixture/home', {}), '/fixture/home/.config/cursor/auth.json');
            assert.equal(getCursorNativeAuthPath('linux', '/fixture/home', { XDG_CONFIG_HOME: '/fixture/xdg' }), '/fixture/xdg/cursor/auth.json');
            assert.equal(getCursorNativeAuthPath('win32', 'C:/Users/fixture', { APPDATA: 'C:/fixture/roaming' }),
                String.raw`C:\fixture\roaming\Cursor\auth.json`);
            assert.equal(await readCursorNativeAccessToken({ env: { CURSOR_AUTH_TOKEN: ' fixture-direct ',
                AGENT_CLI_CREDENTIAL_STORE: 'memory' } }), 'fixture-direct');
            assert.equal(await readCursorNativeAccessToken({ env: { AGENT_CLI_CREDENTIAL_STORE: 'memory',
                CURSOR_API_KEY: 'fixture-api-key' } }), null);
            const diskPaths: string[] = [];
            let disk = JSON.stringify({ accessToken: 'fixture-file', refreshToken: 'must-not-return', apiKey: 'not-bearer' });
            const diskMock = t.mock.method(fs, 'readFileSync', ((path: unknown) => {
                diskPaths.push(String(path)); return disk;
            }) as typeof fs.readFileSync);
            try {
                const options = { platform: 'linux' as const, homeDir: '/fixture/home', env: {} };
                assert.equal(await readCursorNativeAccessToken(options), 'fixture-file');
                assert.deepEqual(diskPaths, ['/fixture/home/.config/cursor/auth.json']);
                for (const malformed of ['{', '[]', 'null', '{"accessToken":42}', '{"accessToken":"  "}', '{"apiKey":"fixture-key"}']) {
                    disk = malformed;
                    assert.equal(await readCursorNativeAccessToken(options), null);
                }
                diskPaths.length = 0;
                keychainStderr = 'password: "fixture-keychain"';
                assert.equal(await readCursorNativeAccessToken({ platform: 'darwin', env: {} }), 'fixture-keychain');
                keychainStderr = 'password: 0x666978747572652d686578';
                assert.equal(await readCursorNativeAccessToken({ platform: 'darwin', env: {} }), 'fixture-hex');
                keychainStderr = 'unrelated "metadata"';
                assert.equal(await readCursorNativeAccessToken({ platform: 'darwin', env: {} }), null);
                assert.equal(diskPaths.length, 0); // default macOS never falls through to stale file
            } finally { diskMock.mock.restore(); }
        });
        await t.test('API key override suppresses stale login; direct token still wins; cookie independent', async () => {
            let storageReads = 0;
            const staleRead = t.mock.method(fs, 'readFileSync', (() => {
                storageReads += 1;
                return JSON.stringify({ accessToken: 'fixture-stale-login' });
            }) as typeof fs.readFileSync);
            const beforeKeychain = keychainCalls;
            calls.length = 0;
            try {
                for (const platform of ['darwin', 'linux', 'win32'] as const) {
                    for (const store of ['default', 'file']) {
                        assert.equal(await readCursorNativeAccessToken({ platform, homeDir: '/fixture/home',
                            env: { CURSOR_API_KEY: ' fixture-api-override ', AGENT_CLI_CREDENTIAL_STORE: store } }), null);
                    }
                }
                assert.equal(await readCursorNativeAccessToken({ env: {
                    CURSOR_AUTH_TOKEN: 'fixture-direct-wins', CURSOR_API_KEY: 'fixture-api-override',
                } }), 'fixture-direct-wins');
                assert.equal(storageReads, 0);
                assert.equal(keychainCalls, beforeKeychain);
                assert.equal(calls.length, 0);
                process.env['CURSOR_API_KEY'] = 'fixture-api-override';
                delete process.env['CURSOR_AUTH_TOKEN'];
                process.env['AGENT_CLI_CREDENTIAL_STORE'] = 'file';
                // Explicit cookie bypasses cookie-file lookup and remains a separate quota source.
                process.env['CURSOR_SESSION_TOKEN'] = 'fixture-cookie';
                response = () => Response.json({ individualUsage: { plan: { totalPercentUsed: 7 } } });
                const result = await fetchCursorUsage('fixture-cursor');
                assert.equal(result.quotaSource, 'cursor-dashboard-unofficial-api');
                assert.deepEqual(calls.map(call => call.url), ['https://cursor.com/api/usage-summary']);
                assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), null);
                assert.equal(storageReads, 0);
                assert.equal(keychainCalls, beforeKeychain);
            } finally {
                staleRead.mock.restore();
                delete process.env['CURSOR_API_KEY'];
                process.env['AGENT_CLI_CREDENTIAL_STORE'] = 'memory';
            }
        });
        await t.test('native primary total and zero pools match reference', async () => {
            assert.deepEqual(normalizeCursorPeriodUsage({ planUsage: { totalPercentUsed: 15.48,
                includedSpend: 23222, limit: 40000, autoPercentUsed: 0, apiPercentUsed: 46.444 },
                billingCycleEnd: '1771077734000' })?.windows, [
                { label: 'Cycle', percent: 15.48, resetsAt: new Date(1771077734000).toISOString() },
                { label: 'First-party models', percent: 0, resetsAt: new Date(1771077734000).toISOString() },
                { label: 'API usage', percent: 46.444, resetsAt: new Date(1771077734000).toISOString() },
            ]);
            assert.deepEqual(normalizeCursorAuthUsage({ 'gpt-4': { numRequests: 150, maxRequestUsage: 500 },
                startOfMonth: '2026-12-31T00:00:00Z' })?.windows,
                [{ label: 'Cycle', percent: 30, resetsAt: '2027-01-31T00:00:00.000Z' }]);
        });
        for (const stage of [0, 1, 2]) await t.test(`reachable native success stage ${stage}`, async () => {
            process.env['CURSOR_AUTH_TOKEN'] = 'fixture-native';
            cliAuthenticated = false;
            calls.length = 0;
            const urls = ['https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
                'https://api2.cursor.sh/api/usage/summary', 'https://api2.cursor.sh/auth/usage'];
            const payloads = [{ planUsage: { totalPercentUsed: 25 } },
                { individualUsage: { plan: { used: 25, limit: 100 } } },
                { 'gpt-4': { numRequests: 1, maxRequestUsage: 4 } }];
            response = () => calls.length - 1 === stage ? Response.json(payloads[stage]) : new Response('{');
            const result = await fetchCursorUsage('fixture-cursor');
            assert.equal(result.authenticated, true);
            assert.equal(result.quotaCapable, true);
            assert.deepEqual(calls.map(c => c.url), urls.slice(0, stage + 1));
            for (const [index, call] of calls.entries()) {
                const headers = new Headers(call.init?.headers);
                assert.equal(headers.get('authorization'), 'Bearer fixture-native');
                assert.equal(headers.get('cookie'), null);
                assert.equal(headers.get('user-agent'), 'cli-jaw-quota');
                assert.equal(headers.get('accept'), 'application/json');
                assert.equal(call.init?.redirect, 'error');
                assert.equal(call.init?.method, index === 0 ? 'POST' : 'GET');
                assert.equal(call.init?.body, index === 0 ? '{}' : undefined);
                assert.equal(headers.get('connect-protocol-version'), index === 0 ? '1' : null);
            }
            assert.ok(!JSON.stringify(result).includes('fixture-native'));
        });
        await t.test('three native failures use existing explicit cookie fallback', async () => {
            calls.length = 0;
            response = () => calls.at(-1)?.url === 'https://cursor.com/api/usage-summary'
                ? Response.json({ individualUsage: { plan: { totalPercentUsed: 12 } } })
                : new Response('', { status: 503 });
            const result = await fetchCursorUsage('fixture-cursor');
            assert.equal(result.quotaSource, 'cursor-dashboard-unofficial-api');
            assert.equal(calls.length, 4);
            assert.equal(new Headers(calls.at(-1)?.init?.headers).get('authorization'), null);
        });

        await t.test('native period aliases, computed precedence and partial pools', () => {
            const first = (plan: Record<string, unknown>) =>
                (normalizeCursorPeriodUsage({ planUsage: plan })?.windows as Window[] | undefined)?.[0]?.percent;
            for (const limit of ['limit', 'limitCents', 'totalLimitCents']) {
                for (const used of ['includedSpend', 'usedCents', 'used']) assert.equal(first({ [limit]: '100', [used]: '30' }), 30);
                for (const remaining of ['remaining', 'remainingCents']) assert.equal(first({ [limit]: 100, [remaining]: 40 }), 60);
            }
            assert.equal(first({ limit: 100, includedSpend: 10, usedCents: 20, used: 30, remaining: 40, totalSpend: 80 }), 10);
            assert.equal(first({ limit: 100, remaining: 40, totalSpend: 80 }), 60);
            assert.equal(first({ limit: 100, totalSpend: 80 }), 80);
            assert.equal(first({ limit: 100, remaining: 150 }), 0);
            assert.equal(first({ percentUsed: '13.7' }), 13.7);
            assert.equal(first({ totalPercentUsed: 15, percentUsed: 40 }), 15);
            assert.equal(first({ totalPercentUsed: 'bad', limit: 100, includedSpend: 27 }), 27);
            assert.equal(first({ totalPercentUsed: 200 }), 100);
            assert.equal(first({ totalPercentUsed: -10 }), 0);
            assert.equal(first({ limit: 0, includedSpend: 0 }), undefined);
            assert.equal(first({ limit: 100, includedSpend: {} }), undefined);
            assert.deepEqual(normalizeCursorPeriodUsage({ planUsage: { autoPercentUsed: 0, apiPercentUsed: 12 } })?.windows,
                [{ label: 'First-party models', percent: 0, resetsAt: null }, { label: 'API usage', percent: 12, resetsAt: null }]);
            for (const body of [{ planUsage: { totalPercentUsed: 1, billingCycleEnd: 1771077734000 } },
                { planUsage: { totalPercentUsed: 1 }, periodEnd: 1771077734 }]) {
                assert.equal((normalizeCursorPeriodUsage(body)?.windows as Window[])[0]!.resetsAt, '2026-02-14T14:02:14.000Z');
            }
            for (const parser of [normalizeCursorPeriodUsage, normalizeCursorNativeSummary, normalizeCursorAuthUsage]) {
                for (const invalid of [null, [], true, 'body', {}, { planUsage: [] }]) assert.equal(parser(invalid), null);
            }
        });
        await t.test('native summary total and auth bucket selection are independent', () => {
            const result = normalizeCursorNativeSummary({ individualUsage: { plan: { totalPercentUsed: '12.5', used: 99, limit: 100 } } });
            assert.equal((result?.windows as Window[])[0]!.percent, 12.5);
            assert.equal(normalizeCursorNativeSummary({ individualUsage: { plan: { apiPercentUsed: 99 } } }), null);
            const meter = (body: unknown) => (normalizeCursorAuthUsage(body)?.windows as Window[] | undefined)?.[0];
            assert.equal(meter({ other: { used: 80, limit: 100 }, 'gpt-4': { numRequests: 2, maxRequestUsage: 10 } })?.percent, 20);
            assert.equal(meter({ 'gpt-4': { used: 50, limit: 0 }, invalid: { used: 4 }, other: { used: 3, maxRequests: '10' } })?.percent, 30);
            assert.equal(meter({ startOfMonth: { used: 1, limit: 2 }, billingCycleStart: { used: 1, limit: 2 } }), undefined);
            assert.equal(meter({ model: { used: 1, limit: 4 }, startOfMonth: '2026-01-31T12:45:00Z' })?.resetsAt, '2026-03-03T00:00:00.000Z');
            assert.equal(meter({ model: { used: 1, limit: 4 }, startOfMonth: 'garbage' })?.resetsAt, null);
        });
        await t.test('empty cookie response differs from valid zero quota', () => {
            const empty = normalizeCursorUsageSummary({});
            assert.equal(empty.authenticated, true);
            assert.equal(empty.quotaCapable, false);
            assert.deepEqual(empty.windows, []);
            assert.deepEqual(summarize({ totalPercentUsed: 0 }, 'bad').windows, [{ label: 'Cycle', percent: 0, resetsAt: null }]);
        });
        await t.test('file and Keychain source failures do not fall through or write', async () => {
            let reads = 0;
            const fileMock = t.mock.method(fs, 'readFileSync', (() => { reads += 1; throw new Error('fixture missing'); }) as typeof fs.readFileSync);
            const before = keychainCalls;
            try {
                assert.equal(await readCursorNativeAccessToken({ platform: 'darwin', env: { AGENT_CLI_CREDENTIAL_STORE: 'file' } }), null);
                assert.equal(reads, 1);
                assert.equal(keychainCalls, before);
                reads = 0;
                keychainError = new Error('fixture keychain locked');
                assert.equal(await readCursorNativeAccessToken({ platform: 'darwin', env: {} }), null);
                assert.equal(reads, 0);
                const security = cliCalls.at(-1)!;
                assert.equal(security.binary, '/usr/bin/security');
                assert.deepEqual(security.args, ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-g']);
                assert.equal(security.options.timeout, 5000);
                assert.equal(security.options.maxBuffer, 64 * 1024);
                keychainError = undefined;
                for (const malformed of ['password: 0xabc', 'password: ""', 'metadata: "private"']) {
                    keychainStderr = malformed;
                    assert.equal(await readCursorNativeAccessToken({ platform: 'darwin', env: {} }), null);
                }
                assert.equal(reads, 0);
            } finally { fileMock.mock.restore(); keychainError = undefined; }
        });
        await t.test('cookie precedence uses env then quota file then settings, without native token conversion', () => {
            delete process.env['CURSOR_AUTH_TOKEN'];
            delete process.env['CURSOR_SESSION_TOKEN'];
            process.env['CURSOR_DASHBOARD_SESSION_TOKEN'] = 'dashboard-env';
            let quotaFile = true;
            const reads: string[] = [];
            const fileMock = t.mock.method(fs, 'readFileSync', ((file: unknown) => {
                reads.push(String(file));
                if (String(file).endsWith('cursor-session-token')) {
                    if (quotaFile) return ' quota-file ';
                    throw new Error('fixture missing');
                }
                assert.ok(String(file).endsWith('settings.json'));
                return JSON.stringify({ quota: { cursorSessionToken: 'settings-cookie' } });
            }) as typeof fs.readFileSync);
            try {
                assert.equal(readCursorDashboardSessionToken(), 'dashboard-env');
                process.env['CURSOR_SESSION_TOKEN'] = 'primary-env';
                assert.equal(readCursorDashboardSessionToken(), 'primary-env');
                assert.equal(reads.length, 0);
                delete process.env['CURSOR_SESSION_TOKEN'];
                delete process.env['CURSOR_DASHBOARD_SESSION_TOKEN'];
                assert.equal(readCursorDashboardSessionToken(), 'quota-file');
                quotaFile = false;
                assert.equal(readCursorDashboardSessionToken(), 'settings-cookie');
            } finally { fileMock.mock.restore(); process.env['CURSOR_SESSION_TOKEN'] = 'fixture-cookie'; }
        });
        await t.test('API-key-only source makes no native request even with stale file; missing sources stay status-only', async () => {
            delete process.env['CURSOR_AUTH_TOKEN'];
            delete process.env['CURSOR_SESSION_TOKEN'];
            delete process.env['CURSOR_DASHBOARD_SESSION_TOKEN'];
            process.env['CURSOR_API_KEY'] = 'api-override';
            process.env['AGENT_CLI_CREDENTIAL_STORE'] = 'file';
            const reads: string[] = [];
            const fileMock = t.mock.method(fs, 'readFileSync', ((file: unknown) => {
                reads.push(String(file));
                if (String(file).endsWith('auth.json')) return '{"accessToken":"stale"}';
                throw new Error('fixture absent cookie');
            }) as typeof fs.readFileSync);
            const before = keychainCalls;
            calls.length = 0;
            try {
                const result = await fetchCursorUsage('fixture-cursor');
                assert.equal(result.authenticated, true);
                assert.equal(result.quotaCapable, false);
                assert.deepEqual(result.windows, []);
                assert.equal(calls.length, 0);
                assert.equal(reads.some(file => file.endsWith('auth.json')), false);
                assert.equal(keychainCalls, before);
                delete process.env['CURSOR_API_KEY'];
                process.env['AGENT_CLI_CREDENTIAL_STORE'] = 'memory';
                cliAuthenticated = false;
                const absent = await fetchCursorUsage('fixture-cursor');
                assert.equal(absent.authenticated, false);
                assert.deepEqual(absent.windows, []);
                assert.equal(calls.length, 0);
                process.env['CURSOR_AUTH_TOKEN'] = 'native-failed';
                response = () => new Response('', { status: 401 });
                const failed = await fetchCursorUsage('fixture-cursor');
                assert.equal(failed.reason, 'native_quota_unavailable');
                assert.equal(failed.authenticated, false);
                assert.equal(calls.length, 3);
            } finally { fileMock.mock.restore(); process.env['CURSOR_SESSION_TOKEN'] = 'fixture-cookie'; }
        });
        for (const kind of ['declared', 'chunked', 'stall', '401', '403', '429', 'throw', 'empty'] as const) {
            await t.test(`native ${kind} failure reaches summary`, async () => {
                calls.length = 0;
                process.env['CURSOR_AUTH_TOKEN'] = 'fixture-native';
                let canceled = 0;
                const realTimeout = globalThis.setTimeout;
                const timeoutMock = kind === 'stall' ? t.mock.method(globalThis, 'setTimeout',
                    ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => realTimeout(fn, ms === 8000 ? 5 : ms, ...args)) as typeof setTimeout) : null;
                response = () => {
                    if (calls.at(-1)?.url.endsWith('/api/usage/summary')) return Response.json({ individualUsage: { plan: { totalPercentUsed: 42 } } });
                    if (kind === 'throw') throw new Error('fixture request failed');
                    if (kind === 'empty') return Response.json({});
                    if (kind === '401' || kind === '403' || kind === '429') return new Response('', { status: Number(kind) });
                    return new Response(new ReadableStream<Uint8Array>({
                        start(controller) { if (kind === 'chunked') controller.enqueue(new Uint8Array(512 * 1024 + 1)); },
                        cancel() { canceled += 1; },
                    }), kind === 'declared' ? { headers: { 'content-length': String(512 * 1024 + 1) } } : {});
                };
                try {
                    const result = await fetchCursorUsage('fixture-cursor');
                    assert.equal(result.quotaSource, 'cursor:usage-summary');
                    assert.equal(calls.length, 2);
                    if (['declared', 'chunked', 'stall'].includes(kind)) assert.equal(canceled, 1);
                } finally { timeoutMock?.mock.restore(); }
            });
        }
        await t.test('native secondary-only zero stops fallback and rereads file token on the next call', async () => {
            delete process.env['CURSOR_AUTH_TOKEN'];
            process.env['AGENT_CLI_CREDENTIAL_STORE'] = 'file';
            let token = 'file-generation-one';
            const fileMock = t.mock.method(fs, 'readFileSync', (() => JSON.stringify({ accessToken: token })) as typeof fs.readFileSync);
            calls.length = 0;
            response = () => Response.json({ planUsage: { autoPercentUsed: 0 } });
            try {
                assert.equal((await fetchCursorUsage('fixture-cursor')).quotaSource, 'cursor:period-usage');
                token = 'file-generation-two';
                await fetchCursorUsage('fixture-cursor');
                assert.equal(calls.length, 2);
                assert.deepEqual(calls.map(c => new Headers(c.init?.headers).get('authorization')),
                    ['Bearer file-generation-one', 'Bearer file-generation-two']);
            } finally { fileMock.mock.restore(); process.env['AGENT_CLI_CREDENTIAL_STORE'] = 'memory'; }
        });
    } finally {
        globalThis.fetch = originalFetch;
        if (oldSession === undefined) delete process.env['CURSOR_SESSION_TOKEN'];
        else process.env['CURSOR_SESSION_TOKEN'] = oldSession;
        if (oldDashboard === undefined) delete process.env['CURSOR_DASHBOARD_SESSION_TOKEN'];
        else process.env['CURSOR_DASHBOARD_SESSION_TOKEN'] = oldDashboard;
        if (oldKey === undefined) delete process.env['CURSOR_API_KEY'];
        else process.env['CURSOR_API_KEY'] = oldKey;
        if (oldAuth === undefined) delete process.env['CURSOR_AUTH_TOKEN'];
        else process.env['CURSOR_AUTH_TOKEN'] = oldAuth;
        if (oldStore === undefined) delete process.env['AGENT_CLI_CREDENTIAL_STORE'];
        else process.env['AGENT_CLI_CREDENTIAL_STORE'] = oldStore;
        t.mock.restoreAll();
    }
});
