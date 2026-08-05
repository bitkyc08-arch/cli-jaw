import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerAgentControlRoutes } from '../../src/routes/agent-control.ts';
import { registerCommandRoutes } from '../../src/routes/command.ts';
import { db } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { createChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { addBroadcastListener, clearAllBroadcastListeners } from '../../src/core/bus.ts';

function noAuth(_req: Request, _res: Response, next: NextFunction): void { next(); }

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    registerAgentControlRoutes(app, noAuth);
    registerCommandRoutes(app, noAuth);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

function post(baseUrl: string, path: string, body?: unknown): Promise<globalThis.Response> {
    return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        ...(body === undefined ? {} : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
    });
}

afterEach(() => {
    clearAllBroadcastListeners();
    db.prepare("DELETE FROM chat_sessions WHERE label LIKE 'unknown-sess%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    settings.multiSession.enabled = false;
});

// 072 §1.1 — stopping or clearing the wrong session is worse than doing nothing.

test('stop refuses a session that no longer exists instead of stopping another one', async () => {
    settings.multiSession.enabled = true;
    const active = createChatSession('unknown-sess-stop');
    setActiveChatSession(active.id);

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/stop', { sessionId: 'gone-session' });
        assert.equal(response.status, 404);
        assert.equal((await response.json()).error, 'unknown_session');
    });
});

test('clear refuses a session that no longer exists and broadcasts nothing', async () => {
    settings.multiSession.enabled = true;
    const events: string[] = [];
    addBroadcastListener(type => { events.push(type); });

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/clear', { sessionId: 'gone-session' });
        assert.equal(response.status, 404);
    });
    assert.deepEqual(events, [], 'a refused clear must not blank anyone');
});

test('clear scopes its broadcast to the session that asked for it', async () => {
    settings.multiSession.enabled = true;
    const viewed = createChatSession('unknown-sess-clear');
    const payloads: Array<Record<string, unknown>> = [];
    addBroadcastListener((type, data) => { if (type === 'clear') payloads.push(data); });

    await withServer(async baseUrl => {
        assert.equal((await post(baseUrl, '/api/clear', { sessionId: viewed.id })).status, 200);
    });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.['scope'], `local:${viewed.id}`);
    assert.equal(payloads[0]?.['sessionId'], viewed.id);
});

// The bundled terminal client and the send button off a session route both call stop
// with no body, and that has always meant "stop everything".
test('stop with no body is still the aggregate stop', async () => {
    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/stop');
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data?.aggregate ?? body.aggregate, true);
    });
});

// The write that matters most: a message posted to a session that is gone must not be
// silently rerouted into whichever session another tab made active.
test('a message naming a session that no longer exists is refused', async () => {
    settings.multiSession.enabled = true;
    const active = createChatSession('unknown-sess-message');
    setActiveChatSession(active.id);

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/message', { prompt: 'hello', sessionId: 'gone-session' });
        assert.equal(response.status, 404);
        assert.equal((await response.json()).error, 'unknown_session');
    });

    const landed = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(active.id) as { n: number };
    assert.equal(landed.n, 0, 'the refused message must not land in another session');
});
