// This route exists because the generic proxy would have let anything reaching the
// manager read the vault, so the tests that matter are the refusals: a port outside the
// range, an instance that is not up, and an instance that dies between being checked and
// being dialled. All three have to look the same to a caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { createDashboardWikiRouter } from '../../src/manager/notes/wiki-routes.ts';

type Row = { port: number; ok?: boolean; status?: string };

function appWith(rows: Row[], requestImpl?: typeof http.request) {
    const app = express();
    app.use('/api/dashboard/wiki', createDashboardWikiRouter({
        managerPort: 24577,
        range: { from: 3457, count: 50 },
        scanSupplier: async () => ({ instances: rows }),
        ...(requestImpl ? { requestImpl } : {}),
    }));
    return app;
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: string }> {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: res.status, body: await res.text() };
    } finally {
        server.close();
    }
}

/** A request that reports an upstream failure instead of connecting anywhere. */
function failingRequest(): typeof http.request {
    return ((_opts: unknown, _cb: unknown) => {
        const req = new EventEmitter() as unknown as http.ClientRequest;
        (req as unknown as { end: () => void }).end = () => {
            setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
        };
        return req;
    }) as unknown as typeof http.request;
}

/** A request that answers as a live instance would. */
function okRequest(payload: unknown): typeof http.request {
    return ((_opts: unknown, cb: (res: unknown) => void) => {
        const req = new EventEmitter() as unknown as http.ClientRequest;
        (req as unknown as { end: () => void }).end = () => {
            const res = new EventEmitter() as unknown as http.IncomingMessage & { pipe: (d: express.Response) => void };
            (res as unknown as { statusCode: number }).statusCode = 200;
            (res as unknown as { headers: Record<string, string> }).headers = { 'content-type': 'application/json' };
            (res as unknown as { pipe: (d: express.Response) => void }).pipe = (destination) => {
                destination.end(JSON.stringify(payload));
            };
            setImmediate(() => cb(res));
        };
        return req;
    }) as unknown as typeof http.request;
}

const ONLINE: Row = { port: 3457, ok: true, status: 'online' };

test('PRX-1: a live instance answers with what the core returned', async () => {
    const app = appWith([ONLINE], okRequest({ ok: true, data: { status: 'ok', entities: [] } }));
    const res = await get(app, '/api/dashboard/wiki/entities?port=3457');
    assert.equal(res.status, 200);
    assert.match(res.body, /"status":"ok"/);
});

test('PRX-2: an offline instance is unavailable, not a transport error', async () => {
    const app = appWith([{ port: 3457, ok: false, status: 'offline' }], failingRequest());
    const res = await get(app, '/api/dashboard/wiki/entities?port=3457');
    assert.equal(res.status, 503);
    assert.match(res.body, /wiki_core_unavailable/);
});

test('PRX-2: a port with no scan row at all is unavailable', async () => {
    const app = appWith([], failingRequest());
    const res = await get(app, '/api/dashboard/wiki/entities?port=3499');
    assert.equal(res.status, 503);
    assert.match(res.body, /wiki_core_unavailable/);
});

test('PRX-2: a missing port is unavailable rather than a guess', async () => {
    const app = appWith([ONLINE], failingRequest());
    const res = await get(app, '/api/dashboard/wiki/entities');
    assert.equal(res.status, 503);
});

test('PRX-2b: a port outside the managed range never reaches a socket', async () => {
    let dialled = false;
    const watching = ((...args: unknown[]) => { dialled = true; return failingRequest()(...(args as [never])); }) as unknown as typeof http.request;
    const app = appWith([{ port: 9999, ok: true, status: 'online' }], watching);

    const res = await get(app, '/api/dashboard/wiki/entities?port=9999');
    assert.equal(res.status, 503);
    assert.equal(dialled, false, 'the range check runs before anything is opened');
});

test('PRX-2c: an instance that dies after the scan still answers unavailable', async () => {
    // The scan is up to ten seconds stale, so "online" can already be untrue by the time
    // the socket opens. That must not surface as a different error.
    const app = appWith([ONLINE], failingRequest());
    const res = await get(app, '/api/dashboard/wiki/entities?port=3457');
    assert.equal(res.status, 503, 'an upstream failure is folded into the same answer');
    assert.match(res.body, /wiki_core_unavailable/);
});

test('PRX-3: a path the caller invents is not proxied', async () => {
    let dialled = false;
    const watching = ((...args: unknown[]) => { dialled = true; return failingRequest()(...(args as [never])); }) as unknown as typeof http.request;
    const app = appWith([ONLINE], watching);

    const res = await get(app, '/api/dashboard/wiki/configure?port=3457');
    assert.equal(res.status, 404);
    assert.equal(dialled, false, 'only the read-only suffixes are forwarded');
});

test('PRX-3: the router exposes no way to write to the vault', async () => {
    const app = appWith([ONLINE], okRequest({ ok: true }));
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/wiki/entities?port=3457`, { method: 'POST' });
        assert.notEqual(res.status, 200, 'no write verb is routed');
    } finally {
        server.close();
    }
});

// The whole reason this route exists rather than reusing the generic proxy: loopback on
// its own must not be a pass. These drive the boundary itself.

test('PRX-4: a foreign browser origin is refused even over loopback', async () => {
    const app = appWith([ONLINE], okRequest({ ok: true }));
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/wiki/entities?port=3457`, {
            headers: { origin: 'http://evil.example' },
        });
        assert.notEqual(res.status, 200, 'a page on another origin cannot read the vault');
        assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`);
    } finally {
        server.close();
    }
});

test('PRX-4b: the manager’s own origin is accepted', async () => {
    const app = appWith([ONLINE], okRequest({ ok: true, data: { status: 'ok' } }));
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/wiki/entities?port=3457`, {
            headers: { origin: 'http://127.0.0.1:24577' },
        });
        assert.equal(res.status, 200);
    } finally {
        server.close();
    }
});
