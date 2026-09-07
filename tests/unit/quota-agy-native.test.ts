import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

let processOutput = '';
let listenerOutput = '';
let commandFailure = false;
const commands: Array<{ binary: string; args: string[]; options: Record<string, unknown> }> = [];
const fakeExec = Object.assign(() => { throw new Error('Unexpected callback invocation'); }, {
    [promisify.custom]: async (binary: string, args: string[], options: Record<string, unknown>) => {
        commands.push({ binary, args, options });
        if (commandFailure) throw new Error('fixture process error');
        if (binary === 'ps' || binary === 'powershell') return { stdout: processOutput, stderr: '' };
        if (['lsof', 'ss', 'netstat'].includes(binary)) return { stdout: listenerOutput, stderr: '' };
        throw new Error('Forbidden process');
    },
});
mock.module('node:child_process', { namedExports: { execFile: fakeExec } });
const { fetchAgyUsage, collapseAgyQuotaWindows, normalizeAntigravityUsageSnapshot } = await import('../../src/routes/quota-agy-reverse.js');
const { readAgyGoogleContext } = await import('../../src/routes/quota-agy-auth.js');
const { readAgyLocalSnapshot } = await import('../../src/routes/quota-agy-local.js');

const summaryUrl = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const modelsUrl = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const projectUrl = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const identity = 'alpha@example.test';
const token = { accessToken: 'fixture-access', refreshToken: 'NEVER-REFRESH', email: identity, expiresAt: 1893456000000, projectId: 'fixture-project' };
const summary = { groups: [
    { displayName: 'Gemini', buckets: [
        { window: '5h', remainingFraction: 0.6, resetTime: '2026-09-09T00:00:00Z' },
        { window: 'weekly', remaining: { remainingFraction: 0.8 } },
    ] },
    { description: 'Claude 3p', buckets: [
        { bucketId: 'five-hour', remainingPercentage: 0.25 },
        { displayName: 'weekly', remainingFraction: 0.9 },
    ] },
] };
const models = { models: {
    'gemini-missing': { quotaInfo: {} },
    'gemini-valid': { quotaInfoByTier: { pro: [{ remainingFraction: 0.425 }] } },
    'claude-valid': { quotaInfos: [{ remaining: { remainingPercentage: 0.75 } }] },
} };
const localBody = { userStatus: { email: identity, isAuthenticated: true, cascadeModelConfigData: { clientModelConfigs: [
    { modelOrAlias: { model: 'gemini-local' }, label: 'Gemini', quotaInfo: { remainingFraction: 0.6 } },
    { modelOrAlias: { model: 'claude-local' }, label: 'Claude', quotaInfo: { remainingFraction: 0 } },
] } } };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const windows = (result: Record<string, unknown>) => result.windows as Array<{ label: string; percent: number; precision?: string; resetsAt?: string }>;

function setup(t: TestContext, platform = 'darwin') {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-agy-fixture-'));
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    const priorAppData = process.env.APPDATA; const priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = path.join(home, 'Roaming'); process.env.XDG_CONFIG_HOME = path.join(home, 'Xdg');
    t.mock.method(os, 'homedir', () => home);
    t.mock.method(Date, 'now', () => 1788825600000);
    processOutput = ''; listenerOutput = ''; commandFailure = false; commands.length = 0;
    const root = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'antigravity-usage')
        : path.join(home, platform === 'win32' ? 'Roaming' : 'Xdg', 'antigravity-usage');
    fs.mkdirSync(path.join(root, 'accounts', identity), { recursive: true });
    const configFile = path.join(root, 'config.json');
    const tokenFile = path.join(root, 'accounts', identity, 'tokens.json');
    fs.writeFileSync(configFile, JSON.stringify({ activeAccount: identity }));
    fs.writeFileSync(tokenFile, JSON.stringify(token));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let respond = (url: string): Response => url === summaryUrl ? json(summary) : url === modelsUrl ? json(models)
        : url === projectUrl ? json({ cloudaicompanionProject: { id: 'discovered-project' } }) : new Response(null, { status: 599 });
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
        calls.push({ url: String(url), init }); return respond(String(url));
    });
    t.after(() => {
        Object.defineProperty(process, 'platform', descriptor);
        if (priorAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = priorAppData;
        if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
        assert.ok(commands.every(call => ['ps', 'powershell', 'lsof', 'ss', 'netstat'].includes(call.binary)));
        assert.ok(calls.every(call => [summaryUrl, modelsUrl, projectUrl].includes(call.url)), 'no Location/token/inference endpoint');
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { home, root, configFile, tokenFile, calls, respond: (fn: typeof respond) => { respond = fn; } };
}

function localTransport(t: TestContext, options: { status?: number; probeStatus?: number; body?: unknown; huge?: boolean; stalled?: boolean; httpsError?: boolean } = {}) {
    processOutput = '123 /Applications/Antigravity.app/language_server --csrf_token="fixture-csrf" --extension_server_port=43123';
    listenerOutput = 'server 123 user 7u IPv4 TCP 127.0.0.1:43123 (LISTEN)';
    const requests: Array<{ secure: boolean; options: http.RequestOptions; body: unknown }> = [];
    const streams: PassThrough[] = [];
    for (const [transport, secure] of [[https, true], [http, false]] as const) {
        t.mock.method(transport, 'request', (opts: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
            const req = new EventEmitter() as EventEmitter & { end: (body: string) => void; destroy: () => void };
            req.destroy = () => { req.emit('close'); };
            req.end = body => {
                requests.push({ secure, options: opts, body: JSON.parse(body) });
                queueMicrotask(() => {
                    if (secure && options.httpsError) { req.emit('error', new Error('fixture handshake failure')); return; }
                    const probe = String(opts.path).endsWith('GetUnleashData');
                    const stream = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
                    streams.push(stream);
                    stream.statusCode = probe ? options.probeStatus ?? 200 : options.status ?? 200;
                    stream.headers = { location: 'https://redirect.invalid/local', ...(options.huge && !probe ? { 'content-length': '524289' } : {}) };
                    callback(stream as unknown as http.IncomingMessage);
                    if (!stream.destroyed && !(options.stalled && !probe)) stream.end(JSON.stringify(probe ? {} : options.body ?? localBody));
                });
            };
            return req as unknown as http.ClientRequest;
        });
    }
    return { requests, streams };
}

test('default AGY reader uses real selected-token supplier and four native windows', async t => {
    const fixture = setup(t);
    const before = fs.readFileSync(fixture.tokenFile);
    const result = await fetchAgyUsage();
    assert.deepEqual(fixture.calls.map(call => call.url), [summaryUrl]);
    const request = fixture.calls[0]!.init;
    assert.equal(request.redirect, 'manual');
    assert.equal(new Headers(request.headers).get('authorization'), 'Bearer fixture-access');
    assert.deepEqual(JSON.parse(String(request.body)), { project: 'fixture-project' });
    assert.deepEqual(windows(result).map(w => w.label), ['Gem', 'Gem (Weekly)', 'Cla', 'Cla (Weekly)']);
    for (const [i, expected] of [40, 20, 75, 10].entries()) assert.ok(Math.abs(windows(result)[i]!.percent - expected) < 1e-9);
    assert.equal(windows(result)[0]!.resetsAt, '2026-09-09T00:00:00.000Z');
    assert.ok(!JSON.stringify(result).includes('fixture-access'));
    assert.ok(!JSON.stringify(result).includes('NEVER-REFRESH'));
    assert.deepEqual(fs.readFileSync(fixture.tokenFile), before);
});

test('missing project discovers it once without storing, refreshing or onboarding', async t => {
    const f = setup(t);
    fs.writeFileSync(f.tokenFile, JSON.stringify({ ...token, projectId: undefined }));
    const before = fs.readFileSync(f.tokenFile);
    const result = await fetchAgyUsage();
    assert.equal(result.quotaCapable, true);
    assert.deepEqual(f.calls.map(c => c.url), [projectUrl, summaryUrl]);
    assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)), { metadata: { ideType: 'ANTIGRAVITY' } });
    assert.deepEqual(JSON.parse(String(f.calls[1]!.init.body)), { project: 'discovered-project' });
    assert.deepEqual(fs.readFileSync(f.tokenFile), before);
});

test('AGY selected-store parsing rejects corrupt selections without falling into legacy', async t => {
    const f = setup(t);
    fs.writeFileSync(path.join(f.root, 'tokens.json'), JSON.stringify(token));
    for (const value of ['{bad', JSON.stringify({ activeAccount: '../elsewhere' }), JSON.stringify({ activeAccount: 7 }), ' '.repeat(524289)]) {
        fs.writeFileSync(f.configFile, value);
        assert.equal(readAgyGoogleContext().kind, 'invalid');
        assert.equal((await fetchAgyUsage()).authenticated, false);
    }
    fs.writeFileSync(f.configFile, JSON.stringify({ activeAccount: 'absent@example.test' }));
    assert.equal(readAgyGoogleContext().kind, 'missing');
    fs.unlinkSync(f.configFile);
    assert.equal(readAgyGoogleContext().kind, 'ready');
    assert.equal((await fetchAgyUsage()).quotaCapable, true);
    assert.deepEqual(f.calls.map(c => c.url), [summaryUrl]);
});

test('AGY token validity handles expiry, identity mismatch, bad bytes and unknown expiry', async t => {
    const f = setup(t);
    for (const patch of [{ accessToken: '' }, { email: 'other@example.test' }, { expiresAt: 'bad' }, { expiresAt: 1e30 }]) {
        fs.writeFileSync(f.tokenFile, JSON.stringify({ ...token, ...patch }));
        assert.equal(readAgyGoogleContext().kind, 'invalid');
    }
    fs.writeFileSync(f.tokenFile, Buffer.from([0xff]));
    assert.equal(readAgyGoogleContext().kind, 'invalid');
    fs.writeFileSync(f.tokenFile, JSON.stringify({ ...token, expiresAt: 1 }));
    assert.equal((await fetchAgyUsage()).reason, 'agy_token_expired');
    assert.equal(f.calls.length, 0);
    fs.writeFileSync(f.tokenFile, JSON.stringify({ ...token, expiresAt: undefined }));
    assert.equal((await fetchAgyUsage()).quotaCapable, true);
});

test('AGY default supplier platform paths use native APPDATA/XDG and same active record', async t => {
    for (const platform of ['win32', 'linux']) await t.test(platform, async t => {
        const f = setup(t, platform);
        if (platform === 'win32') processOutput = '[]';
        assert.equal(readAgyGoogleContext().kind, 'ready');
        assert.equal((await fetchAgyUsage()).quotaCapable, true);
        assert.deepEqual(f.calls.map(c => c.url), [summaryUrl]);
    });
});

test('AGY network/empty/HTTP/body failures fall back to models with exact tier fractions', async t => {
    const f = setup(t);
    for (const scenario of ['network', 'empty', 'http', 'body', 'oversized']) {
        f.calls.length = 0;
        f.respond(url => {
            if (url === modelsUrl) return json(models);
            if (scenario === 'network') throw new Error('fixture-secret');
            if (scenario === 'empty') return json({ groups: [] });
            if (scenario === 'http') return new Response(null, { status: 503 });
            if (scenario === 'oversized') return new Response('x', { headers: { 'content-length': '524289' } });
            return new Response('{invalid');
        });
        const result = await fetchAgyUsage();
        assert.deepEqual(f.calls.map(c => c.url), [summaryUrl, modelsUrl]);
        assert.equal(result.quotaSource, 'agy:fetchAvailableModels');
        assert.deepEqual(windows(result).map(w => w.percent), [57.5, 25]);
    }
});

test('AGY manual redirect is terminal at project, summary and models; no Location request', async t => {
    const f = setup(t);
    for (const stage of ['project', 'summary', 'models']) {
        fs.writeFileSync(f.tokenFile, JSON.stringify({ ...token, projectId: stage === 'project' ? undefined : token.projectId }));
        for (const status of [300, 301, 302, 303, 307, 308, 399, 401, 403]) {
            f.calls.length = 0;
            f.respond(url => stage === 'models' && url === summaryUrl ? json({})
                : new Response(null, { status, headers: { location: 'https://redirect.invalid/quota' } }));
            const result = await fetchAgyUsage();
            assert.deepEqual(f.calls.map(c => c.url), stage === 'project' ? [projectUrl] : stage === 'models' ? [summaryUrl, modelsUrl] : [summaryUrl]);
            assert.ok(f.calls.every(c => c.init.redirect === 'manual'));
            assert.equal(result.reason, status >= 400 ? 'agy_token_expired' : 'agy_redirect_rejected');
            assert.deepEqual(result.windows, []);
            assert.ok(!JSON.stringify(result).includes('redirect.invalid'));
        }
    }
});

test('AGY local+Google same account upgrades; redirect cannot substitute local', async t => {
    const f = setup(t);
    const local = localTransport(t);
    assert.equal((await fetchAgyUsage()).quotaSource, 'agy:retrieveUserQuotaSummary');
    assert.equal(local.requests.length, 2);
    f.calls.length = 0;
    f.respond(() => new Response(null, { status: 302, headers: { location: 'https://redirect.invalid/local-substitute' } }));
    const redirected = await fetchAgyUsage();
    assert.equal(redirected.reason, 'agy_redirect_rejected');
    assert.deepEqual(redirected.windows, []);
    assert.deepEqual(f.calls.map(c => c.url), [summaryUrl]);
    for (const req of local.requests) {
        assert.equal(req.options.hostname, '127.0.0.1');
        assert.equal(new Headers(req.options.headers as Record<string, string>).get('x-codeium-csrf-token'), 'fixture-csrf');
        assert.equal(new Headers(req.options.headers as Record<string, string>).get('authorization'), null);
    }
});

test('local IDE fallback works without a stored token and preserves exact Connect request', async t => {
    const f = setup(t); fs.unlinkSync(f.tokenFile);
    const local = localTransport(t);
    const result = await fetchAgyUsage();
    assert.equal(result.quotaSource, 'agy:antigravity-usage:local');
    assert.deepEqual(windows(result).map(w => w.percent), [40, 100]);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(local.requests.map(req => req.body), [{ wrapper_data: {} }, { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }]);
    assert.ok(commands.every(call => call.options.timeout === 5000 && call.options.maxBuffer === 524288));
    assert.ok(local.requests.every(req => req.options.port === 43123));
});

test('local redirect is never downgraded or followed and a 401 probe alone is not auth', async t => {
    const f = setup(t);
    const local = localTransport(t, { probeStatus: 302 });
    const result = await fetchAgyUsage();
    assert.equal(result.reason, 'agy_local_redirect_rejected');
    assert.equal(local.requests.length, 1);
    assert.equal(f.calls.length, 0);
});

test('local 401 status, unknown shapes and oversized bodies never fabricate windows', async t => {
    for (const scenario of ['auth', 'shape', 'oversized']) await t.test(scenario, async t => {
        const f = setup(t); fs.unlinkSync(f.tokenFile);
        const local = localTransport(t, { probeStatus: 401, status: scenario === 'auth' ? 401 : 200,
            body: scenario === 'shape' ? { userStatus: { email: identity } } : localBody, huge: scenario === 'oversized' });
        const result = await fetchAgyUsage();
        assert.equal(result.quotaCapable, false);
        assert.deepEqual(result.windows, []);
        assert.equal(f.calls.length, 0);
        assert.equal(local.requests.length, 2);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok(local.streams.every(stream => stream.destroyed));
    });
});

test('local stalled stream terminates and insecure retry is confined to literal loopback', async t => {
    setup(t);
    const realTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        realTimeout(callback, ms === 5000 ? 15 : ms, ...args)) as typeof setTimeout);
    const local = localTransport(t, { httpsError: true, stalled: true });
    assert.equal((await readAgyLocalSnapshot()).kind, 'unavailable');
    assert.deepEqual(local.requests.map(req => req.secure), [true, false, false]);
    assert.ok(local.streams.every(stream => stream.destroyed));
});

test('local platform discovery, extension port fallback and ambiguous processes stay bounded', async t => {
    for (const platform of ['darwin', 'linux', 'win32']) await t.test(platform, async t => {
        setup(t, platform);
        const local = localTransport(t);
        if (platform === 'win32') processOutput = JSON.stringify([{ ProcessId: 123, CommandLine: 'C:\\Antigravity\\language_server.exe --csrf_token fixture-csrf --extension_server_port 43123' }]);
        listenerOutput = '';
        assert.equal((await readAgyLocalSnapshot()).kind, 'snapshot');
        assert.equal(local.requests[0]!.options.port, 43123);
        processOutput = platform === 'win32' ? JSON.stringify([
            { ProcessId: 123, CommandLine: 'Antigravity language_server --csrf_token a' },
            { ProcessId: 124, CommandLine: 'Antigravity language_server --csrf_token b' },
        ]) : '123 Antigravity language_server --csrf_token a\n124 Antigravity language_server --csrf_token b';
        const count = local.requests.length;
        assert.equal((await readAgyLocalSnapshot()).kind, 'unavailable');
        assert.equal(local.requests.length, count);
    });
});

test('missing legacy fractions cannot shadow valid models; exact native 0/1 stays numeric', async t => {
    assert.deepEqual(collapseAgyQuotaWindows([{ label: 'Gemini' }, { label: 'Gemini', remainingPercentage: 0.5 }]).map(w => w.percent), [50]);
    assert.deepEqual(collapseAgyQuotaWindows([{ label: 'Claude', isExhausted: true }]).map(w => w.percent), [100]);
    assert.deepEqual(normalizeAntigravityUsageSnapshot(null as never).windows, []);
    const f = setup(t);
    f.respond(() => json({ groups: [{ displayName: 'Gemini', buckets: [
        { window: '5h', remainingFraction: 1 }, { window: 'weekly', remainingFraction: 0 },
    ] }] }));
    const result = await fetchAgyUsage();
    assert.deepEqual(windows(result).map(w => [w.percent, w.precision]), [[0, undefined], [100, undefined]]);
});

test('AGY selection remains paired across an active-account change while local probe awaits', async t => {
    const f = setup(t);
    commandFailure = true;
    const pending = fetchAgyUsage();
    fs.writeFileSync(f.configFile, JSON.stringify({ activeAccount: 'other@example.test' }));
    const result = await pending;
    assert.equal(result.quotaCapable, true);
    assert.equal((result.account as Record<string, unknown>).email, identity);
    assert.equal(new Headers(f.calls[0]!.init.headers).get('authorization'), 'Bearer fixture-access');
});

test('READY beta Google account cannot borrow authenticated alpha local IDE quota', async t => {
    const f = setup(t);
    localTransport(t);
    const other = 'beta@example.test';
    fs.mkdirSync(path.join(f.root, 'accounts', other));
    fs.writeFileSync(path.join(f.root, 'accounts', other, 'tokens.json'), JSON.stringify({ ...token, email: other, accessToken: 'beta-access', projectId: 'beta-project' }));
    fs.writeFileSync(f.configFile, JSON.stringify({ activeAccount: other }));
    const selected = readAgyGoogleContext();
    assert.equal(selected.kind, 'ready');
    assert.deepEqual(selected, {
        kind: 'ready', source: 'active-account', email: other,
        accessToken: 'beta-access', projectId: 'beta-project',
    });
    const result = await fetchAgyUsage();
    assert.equal(result.quotaSource, 'agy:antigravity-usage:local');
    assert.equal((result.account as Record<string, unknown>).email, identity);
    assert.equal(f.calls.length, 0);
});

test('missing local identity cannot authorize Google upgrade and unavailable Google retains same-account local source', async t => {
    await t.test('missing local identity', async t => {
        const f = setup(t);
        localTransport(t, { body: { userStatus: { ...localBody.userStatus, email: undefined } } });
        assert.equal((await fetchAgyUsage()).quotaSource, 'agy:antigravity-usage:local');
        assert.equal(f.calls.length, 0);
    });
    await t.test('same-account transient fallback', async t => {
        const f = setup(t); localTransport(t);
        f.respond(() => new Response(null, { status: 503 }));
        assert.equal((await fetchAgyUsage()).quotaSource, 'agy:antigravity-usage:local');
        assert.deepEqual(f.calls.map(c => c.url), [summaryUrl, modelsUrl]);
    });
});

test('summary deduplicates first valid windows and preserves unknown groups in stable order', async t => {
    const f = setup(t);
    f.respond(() => json({ groups: [
        null,
        { displayName: 'Zeta', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] },
        { displayName: 'Gemini', buckets: [
            { window: '5h' }, { window: '5h', remainingFraction: '0.625', resetTime: 'not-a-date' },
            { window: '5h', remainingFraction: 0 }, { window: 'unclassified', remainingFraction: 0.1 },
        ] },
        { displayName: 'Alpha', buckets: [{ window: '5h', remainingFraction: 0.9 }] },
    ] }));
    const result = await fetchAgyUsage();
    assert.deepEqual(windows(result).map(w => w.label), ['Gem', 'Alpha', 'Zeta (Weekly)']);
    assert.equal(windows(result)[0]!.percent, 37.5);
    assert.equal(windows(result)[0]!.resetsAt, null);
    assert.deepEqual(f.calls.map(c => c.url), [summaryUrl]);
});

test('model object/array/tier forms handle malformed rows and all-unknown responses', async t => {
    const f = setup(t);
    let payload: unknown = { models: {
        'gemini-a': { quotaInfo: [null, {}, { remainingFraction: '0.5' }] },
        'unknown-model': { quotaInfoByTier: { 'Claude Sonnet': { remainingPercentage: '0.2' } } },
    } };
    f.respond(url => json(url === summaryUrl ? {} : payload));
    assert.deepEqual(windows(await fetchAgyUsage()).map(w => w.percent), [50, 80]);
    for (const value of [null, [], { models: [] }, { models: { 'gemini-a': { quotaInfo: {} } } }]) {
        payload = value;
        const result = await fetchAgyUsage();
        assert.equal(result.reason, 'agy_usage_unavailable');
        assert.deepEqual(result.windows, []);
        assert.notEqual(result.authenticated, false);
    }
});

test('AGY reads invoke no filesystem mutation APIs', async t => {
    const f = setup(t);
    const mutations: string[] = [];
    const tracked = ['writeFileSync', 'mkdirSync', 'unlinkSync', 'renameSync', 'rmSync'] as const;
    const mocks = tracked.map(name => t.mock.method(fs, name, (() => {
        mutations.push(name); throw new Error('Forbidden filesystem mutation');
    }) as never));
    try {
        const result = await fetchAgyUsage();
        assert.equal(result.quotaCapable, true);
        assert.equal(f.calls.length, 1);
        assert.deepEqual(mutations, []);
    } finally { for (const entry of mocks) entry.mock.restore(); }
});

test('invalid PID/port and foreign listener cannot receive a local credential', async t => {
    setup(t);
    const local = localTransport(t);
    listenerOutput = '';
    for (const candidate of [
        '0 Antigravity language_server --csrf_token fixture-csrf --extension_server_port 43123',
        '123 Antigravity language_server --csrf_token fixture-csrf --extension_server_port 65536',
        '123 Antigravity language_server --csrf_token fixture-csrf --extension_server_port 12oops',
        '123 Antigravity server installation script --csrf_token fixture-csrf --extension_server_port 43123',
    ]) {
        processOutput = candidate;
        assert.equal((await readAgyLocalSnapshot()).kind, 'unavailable');
    }
    assert.equal(local.requests.length, 0);
});

test('local GetUserStatus redirect is terminal after successful probe', async t => {
    const f = setup(t);
    const local = localTransport(t, { status: 307 });
    const result = await fetchAgyUsage();
    assert.equal(result.reason, 'agy_local_redirect_rejected');
    assert.equal(local.requests.length, 2);
    assert.ok(local.requests.every(req => req.secure));
    assert.equal(f.calls.length, 0);
});
