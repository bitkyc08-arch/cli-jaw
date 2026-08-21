// Telegram request cancellation, driven through the PRODUCTION fetch factory.
//
// grammY passes a per-call AbortSignal into its client fetch. This repo replaces
// that fetch to force IPv4, and the replacement originally dropped the signal —
// so every 'bounded' call settled its promise while the socket kept running and
// a shutdown drain returned with work still in flight. grammY's own default API
// timeout is 500 seconds, so nothing else would have stopped it.
//
// createIpv4Fetch takes an injectable request factory precisely so this test can
// point the REAL implementation at a local server instead of reimplementing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer, type Server } from 'node:http';
import { createIpv4Fetch, type RequestFactory } from '../../src/telegram/ipv4-fetch.ts';

async function neverRespondingServer(): Promise<{ server: Server; port: number }> {
    const server = createServer(() => { /* deliberately never responds */ });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as { port: number }).port };
}

/** The production factory, pointed at plain http for a local server. */
function localFetch() {
    return createIpv4Fetch({
        request: http.request as unknown as RequestFactory,
        // Explicitly none: the default https.Agent cannot serve http.request.
        agent: null,
    });
}

test('an in-flight request is destroyed when its signal aborts', async () => {
    const { server, port } = await neverRespondingServer();
    const fetchImpl = localFetch();
    const controller = new AbortController();

    const started = Date.now();
    const pending = fetchImpl(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);

    // The promise must REJECT because the socket was destroyed — not resolve,
    // and not hang until the server closes.
    await assert.rejects(pending, /aborted|socket hang up|ECONNRESET/i);
    assert.ok(Date.now() - started < 3000, 'the request must not outlive its signal');
    await new Promise<void>(resolve => server.close(() => resolve()));
});

test('an already-aborted signal never opens a socket at all', async () => {
    let opened = 0;
    const fetchImpl = createIpv4Fetch({
        request: ((opts, cb) => { opened += 1; return http.request(opts as never, cb as never); }) as unknown as RequestFactory,
        agent: null,
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        fetchImpl('https://127.0.0.1:1/', { signal: controller.signal }),
        /telegram_request_aborted/,
    );
    assert.equal(opened, 0, 'an aborted call must not reach the network');
});

test('a request with no signal still completes normally', async () => {
    // The bound is opt-in at this layer; callers compose their own timeouts.
    const server = createServer((_req, res) => { res.statusCode = 200; res.end('{"ok":true}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const result = await localFetch()(`http://127.0.0.1:${port}/`, {}) as {
        ok: boolean; status: number; json(): Promise<unknown>;
    };
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
});

test('bot.ts wires the production factory rather than an inline closure', async () => {
    // Guards the seam: an inline reimplementation in bot.ts would make every
    // test above prove only this file.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'src/telegram/bot.ts'), 'utf8');
    assert.match(src, /createIpv4Fetch\(/, 'bot.ts must call the exported factory');
    assert.equal(src.includes('https.request('), false, 'no inline request implementation');
});
