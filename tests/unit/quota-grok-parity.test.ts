import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fetchGrokBilling, parseGrokCreditsResponse } from '../../src/routes/quota.ts';

const billingUrl = 'https://cli-chat-proxy.grok.com/v1/billing';
const weekly = (percent?: unknown, end: unknown = '2026-10-01T00:00:00Z') => ({
    config: { ...(percent === undefined ? {} : { creditUsagePercent: percent }),
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end } },
});
const monthly = { config: { monthlyLimit: { val: '10000' }, used: { val: '2500' },
    billingPeriodEnd: '2026-10-01T00:00:00Z' } };

test('Grok JSON weekly schema, numeric values and optional reset', () => {
    assert.equal(parseGrokCreditsResponse(weekly(57.4))?.percent, 57.4);
    assert.equal(parseGrokCreditsResponse(weekly())?.percent, 0);
    assert.equal(parseGrokCreditsResponse(weekly('12.5'))?.percent, 12.5);
    assert.equal(parseGrokCreditsResponse(weekly(150))?.percent, 100);
    assert.equal(parseGrokCreditsResponse(weekly(-1))?.percent, 0);
    assert.deepEqual(parseGrokCreditsResponse(weekly(42, 1e20)), { percent: 42 });
    for (const value of [null, false, '', 'invalid', {}, []]) {
        assert.equal(parseGrokCreditsResponse(weekly(value)), null);
    }
    for (const value of [null, [], {}, { config: {} }, {
        config: { creditUsagePercent: 12, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } },
    }]) assert.equal(parseGrokCreditsResponse(value), null);
});

test('Grok real coordinator uses native identity and isolated fallback', async (t) => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'jaw-grok-parity-'));
    const originalFetch = globalThis.fetch;
    fs.mkdirSync(join(home, '.grok'));
    const writeAuth = (entries: Record<string, unknown>) => fs.writeFileSync(
        join(home, '.grok', 'auth.json'), JSON.stringify(entries));
    const native = (key = 'fixture-access', user_id?: string) => ({ key, user_id, email: 'fixture@example.invalid' });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const install = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
        calls.length = 0;
        globalThis.fetch = (async (input, init) => {
            const url = String(input); calls.push({ url, init });
            return handler(url, init);
        }) as typeof fetch;
    };
    try {
        await t.test('native user_id first, complete headers, no secret serialization', async () => {
            const jwt = `e30.${Buffer.from(JSON.stringify({ sub: 'jwt-id' })).toString('base64url')}.fixture`;
            writeAuth({ 'https://auth.x.ai::fixture': native(jwt, 'native-id') });
            install(() => Response.json(weekly(31)));
            const result = await fetchGrokBilling(home);
            assert.equal(result?.source, 'grok:cli-chat-proxy-billing-credits');
            assert.equal(result?.percent, 31);
            assert.equal(result?.limitUsd, undefined);
            assert.equal(calls.length, 1);
            const call = calls[0]!;
            assert.equal(call.url, `${billingUrl}?format=credits`);
            assert.equal(call.init?.method ?? 'GET', 'GET');
            assert.equal(call.init?.body, undefined);
            assert.equal(call.init?.redirect, 'error');
            assert.ok(call.init?.signal);
            const headers = new Headers(call.init?.headers);
            for (const [key, value] of Object.entries({ authorization: `Bearer ${jwt}`,
                accept: 'application/json', 'x-userid': 'native-id', 'x-xai-token-auth': 'xai-grok-cli',
                'x-authenticateresponse': 'authenticate-response', 'x-grok-client-version': '0.2.93' })) {
                assert.equal(headers.get(key), value);
            }
            assert.ok(!JSON.stringify(result).includes(jwt));
            assert.ok(!JSON.stringify(result).includes('native-id'));
            writeAuth({ 'https://auth.x.ai::fixture': native(jwt) });
            await fetchGrokBilling(home);
            assert.equal(new Headers(calls.at(-1)?.init?.headers).get('x-userid'), 'jwt-id');
        });
        for (const failure of ['throw', '503', 'malformed', 'oversize', 'wrong-period'] as const) {
            await t.test(`${failure} weekly failure still reaches monthly`, async () => {
                writeAuth({ 'https://auth.x.ai::fixture': native('fixture-access', 'fixture-user') });
                install((url) => {
                    if (url.endsWith('format=credits')) {
                        if (failure === 'throw') throw new Error('fixture timeout');
                        if (failure === '503') return new Response('', { status: 503 });
                        if (failure === 'malformed') return new Response('{');
                        if (failure === 'oversize') return new Response('{}', { headers: { 'content-length': String(512 * 1024 + 1) } });
                        return Response.json({ config: { currentPeriod: { type: 'MONTHLY' } } });
                    }
                    if (url.includes('GetGrokCreditsConfig')) throw new Error('fixture gRPC unavailable');
                    if (url === billingUrl) return Response.json(monthly);
                    return new Response('{'); // user parse must not discard billing
                });
                const result = await fetchGrokBilling(home);
                assert.equal(result?.periodLabel, 'monthly');
                assert.equal(result?.percent, 25);
                assert.equal(result?.email, 'fixture@example.invalid');
                assert.ok(calls.some(c => c.url === billingUrl));
            });
        }
        await t.test('opaque token skips JSON; invalid monthly limit is unavailable', async () => {
            writeAuth({ 'https://auth.x.ai::fixture': native() });
            install(url => url === billingUrl ? Response.json({ config: {
                monthlyLimit: { val: 0 }, used: { val: 0 },
            } }) : new Response('', { status: 404 }));
            assert.equal(await fetchGrokBilling(home), null);
            assert.ok(!calls.some(c => c.url.includes('format=credits')));
        });
        await t.test('one candidate throw does not suppress the next native candidate', async () => {
            writeAuth({ 'https://auth.x.ai::one': native('fixture-one', 'one'),
                'https://auth.x.ai::two': native('fixture-two', 'two') });
            install((_url, init) => {
                if (new Headers(init?.headers).get('x-userid') === 'one') throw new Error('fixture failure');
                return Response.json(weekly(0));
            });
            assert.equal((await fetchGrokBilling(home))?.percent, 0);
            assert.equal(calls.length, 2);
        });
        await t.test('gRPC compatibility success precedes monthly and preserves wire headers', async () => {
            writeAuth({ 'https://auth.x.ai::fixture': native('fixture-access', 'fixture-user') });
            // protobuf: config(field 1) contains usage float(field 1) and reset timestamp(field 5.1).
            const reset = Math.floor(Date.now() / 1000) + 7 * 86400;
            const varint = (input: number) => {
                const bytes: number[] = [];
                do { const rest = Math.floor(input / 128); bytes.push(input % 128 + (rest ? 128 : 0)); input = rest; } while (input);
                return Buffer.from(bytes);
            };
            const used = Buffer.alloc(5); used[0] = 13; used.writeFloatLE(27.5, 1);
            const timestamp = Buffer.concat([Buffer.from([8]), varint(reset)]);
            const config = Buffer.concat([used, Buffer.from([42, timestamp.length]), timestamp]);
            const payload = Buffer.concat([Buffer.from([10, config.length]), config]);
            const frame = Buffer.alloc(5); frame.writeUInt32BE(payload.length, 1);
            install(url => url.includes('GetGrokCreditsConfig')
                ? new Response(Buffer.concat([frame, payload])) : new Response('', { status: 503 }));
            const result = await fetchGrokBilling(home);
            assert.equal(result?.source, 'grok:grok-build-billing-grpc-web');
            assert.equal(result?.percent, 28); // retained gRPC rounding contract
            assert.equal(result?.periodEnd, new Date(reset * 1000).toISOString());
            assert.equal(result?.usedUsd, undefined);
            assert.equal(calls.length, 2);
            const call = calls[1]!;
            assert.equal(call.init?.method, 'POST');
            assert.equal(call.init?.redirect, 'error');
            assert.deepEqual(call.init?.body, Buffer.alloc(5));
            const headers = new Headers(call.init?.headers);
            assert.equal(headers.get('content-type'), 'application/grpc-web+proto');
            assert.equal(headers.get('x-grpc-web'), '1');
            assert.equal(headers.get('authorization'), 'Bearer fixture-access');
            assert.equal(headers.get('origin'), 'https://grok.com');
        });
        for (const declared of [true, false]) await t.test(`gRPC ${declared ? 'declared' : 'chunked'} overflow cancels and falls back`, async () => {
            writeAuth({ 'https://auth.x.ai::fixture': native() });
            let canceled = 0;
            install(url => {
                if (url.includes('GetGrokCreditsConfig')) return new Response(new ReadableStream<Uint8Array>({
                    start(controller) { if (!declared) controller.enqueue(new Uint8Array(512 * 1024 + 1)); },
                    cancel() { canceled += 1; },
                }), declared ? { headers: { 'content-length': String(512 * 1024 + 1) } } : {});
                return url === billingUrl ? Response.json(monthly) : Response.json({ email: 'upstream@example.invalid' });
            });
            const result = await fetchGrokBilling(home);
            assert.equal(result?.periodLabel, 'monthly');
            assert.equal(result?.email, 'upstream@example.invalid');
            assert.equal(canceled, 1);
        });
        await t.test('native OIDC priority, deduplication and legacy order apply per stage', async () => {
            const legacy = `e30.${Buffer.from('{"sub":"legacy-id"}').toString('base64url')}.fixture`;
            fs.mkdirSync(join(home, '.progrok'), { recursive: true });
            fs.writeFileSync(join(home, '.progrok', 'auth.json'), JSON.stringify({ accessToken: legacy }));
            writeAuth({ other: native('other', 'other-id'),
                'https://auth.x.ai::first': native('oidc', 'oidc-id'),
                'https://auth.x.ai::duplicate': native('oidc', 'duplicate-id') });
            install(url => url === billingUrl ? Response.json({ config: { monthlyLimit: { val: 0 } } }) : new Response('', { status: 404 }));
            assert.equal(await fetchGrokBilling(home), null);
            const expected = ['Bearer oidc', 'Bearer other', `Bearer ${legacy}`];
            for (const match of ['format=credits', 'GetGrokCreditsConfig', '/v1/billing']) {
                assert.deepEqual(calls.filter(c => c.url.endsWith(match)).map(c => new Headers(c.init?.headers).get('authorization')), expected);
            }
            install((url, init) => url === billingUrl && new Headers(init?.headers).get('authorization') === `Bearer ${legacy}`
                ? Response.json(monthly) : new Response('', { status: 404 }));
            assert.equal((await fetchGrokBilling(home))?.source, 'progrok:billing-api');
            fs.rmSync(join(home, '.progrok'), { recursive: true });
        });
        for (const value of [undefined, null, false, '', 'bad', 0, -1]) await t.test(`monthly rejects limit ${String(value)}`, async () => {
            writeAuth({ 'https://auth.x.ai::fixture': native() });
            install(url => url === billingUrl ? Response.json({ config: { monthlyLimit: { val: value }, used: { val: 0 } } })
                : new Response('', { status: 404 }));
            assert.equal(await fetchGrokBilling(home), null);
        });
        await t.test('monthly numeric strings, clamping and invalid reset; malformed first candidate continues', async () => {
            writeAuth({ 'https://auth.x.ai::one': native('one'), 'https://auth.x.ai::two': native('two') });
            install((url, init) => {
                if (url === billingUrl) return new Headers(init?.headers).get('authorization') === 'Bearer one'
                    ? new Response('{') : Response.json({ config: { monthlyLimit: { val: '100' }, used: { val: '250' }, billingPeriodEnd: 1e20 } });
                if (url.endsWith('/user')) return Response.json({ email: { secret: 'must-not-escape' } });
                return new Response('', { status: 404 });
            });
            const result = await fetchGrokBilling(home);
            assert.equal(result?.percent, 100);
            assert.equal(result?.limitUsd, 1);
            assert.equal(result?.usedUsd, 2.5);
            assert.equal(result?.periodEnd, undefined);
            assert.equal(result?.email, 'fixture@example.invalid');
            assert.ok(!JSON.stringify(result).includes('must-not-escape'));
        });
        for (const mode of ['401', 'reject', 'malformed']) await t.test(`optional user ${mode} cannot discard monthly`, async () => {
            writeAuth({ 'https://auth.x.ai::fixture': native() });
            install(url => {
                if (url === billingUrl) return Response.json(monthly);
                if (url.endsWith('/user')) {
                    if (mode === 'reject') throw new Error('fixture user timeout');
                    return mode === '401' ? new Response('', { status: 401 }) : new Response('{');
                }
                return new Response('', { status: 404 });
            });
            assert.equal((await fetchGrokBilling(home))?.percent, 25);
        });
        await t.test('missing and malformed native stores make no requests', async () => {
            fs.rmSync(join(home, '.grok', 'auth.json'));
            install(() => { throw new Error('unexpected network'); });
            assert.equal(await fetchGrokBilling(home), null);
            for (const raw of ['{', 'null', '[]', '{"scope":{"key":"  "}}']) {
                fs.writeFileSync(join(home, '.grok', 'auth.json'), raw);
                assert.equal(await fetchGrokBilling(home), null);
            }
            assert.equal(calls.length, 0);
        });
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(home, { recursive: true, force: true });
    }
});
