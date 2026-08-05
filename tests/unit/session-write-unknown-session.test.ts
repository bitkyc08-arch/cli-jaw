import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerAgentControlRoutes } from '../../src/routes/agent-control.ts';
import { registerCommandRoutes } from '../../src/routes/command.ts';
import { db } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { createChatSession, resolveOrCreateRemoteSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
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
    db.prepare('DELETE FROM remote_session_bindings').run();
    db.prepare("DELETE FROM chat_sessions WHERE label LIKE 'unknown-sess%'").run();
    db.prepare("DELETE FROM messages WHERE session_id LIKE '%' AND content LIKE '%session%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    settings.multiSession.enabled = false;
    settings.multiSession.channels.telegram = false;
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

// The rejection tests above would all still pass if a named session were simply ignored
// and the write fell through to the active one. This is the positive half: the message
// has to land in the session that was named, not in the one that happens to be active.
test('a message naming a session lands in that session, not the active one', async () => {
    settings.multiSession.enabled = true;
    const named = createChatSession('unknown-sess-target');
    const active = createChatSession('unknown-sess-elsewhere');
    setActiveChatSession(active.id);

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/message', { prompt: 'goes to the named session', sessionId: named.id });
        assert.equal(response.status, 200, await response.text());
    });

    const inNamed = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND content = 'goes to the named session'").get(named.id) as { n: number };
    const inActive = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(active.id) as { n: number };
    assert.equal(inNamed.n, 1, 'the named session received the message');
    assert.equal(inActive.n, 0, 'the globally active session received nothing');
});

// A command mutates the session it runs in, so it has to run in the named one. Without
// that, /compact typed into one tab resets a different session's conversation. /compact
// is the right probe because it writes its marker into the session it acted on, whereas
// /clear only blanks the screen.
test('a command naming a session executes against that session', async () => {
    settings.multiSession.enabled = true;
    const named = createChatSession('unknown-sess-cmd');
    const active = createChatSession('unknown-sess-cmd-other');
    setActiveChatSession(active.id);
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'history in the named session', ?)").run(named.id);

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/command', { text: '/compact', sessionId: named.id });
        assert.equal(response.status, 200, await response.text());
    });

    // The compact marker lands in the session the command was told to act on.
    const inNamed = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'").get(named.id) as { n: number };
    const inActive = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'").get(active.id) as { n: number };
    assert.equal(inNamed.n, 1, 'the named session was compacted');
    assert.equal(inActive.n, 0, 'the globally active session was left alone');
});

test('a command naming a session that no longer exists is refused', async () => {
    settings.multiSession.enabled = true;
    const active = createChatSession('unknown-sess-cmd-missing');
    setActiveChatSession(active.id);
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'must survive', ?)").run(active.id);

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/command', { text: '/compact', sessionId: 'gone-session' });
        assert.equal(response.status, 404);
    });

    const survived = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(active.id) as { n: number };
    assert.equal(survived.n, 1, 'a refused command must not touch another session');
});

// A targeted request carries no session id: its session comes from the remote binding,
// which the gateway resolves for ordinary messages. Slash commands are intercepted before
// that point, so a Telegram topic running /compact would otherwise reset the globally
// active session rather than its own (072 §1.2a).
test('a targeted slash command runs in the remote conversation session', async () => {
    settings.multiSession.enabled = true;
    // Telegram multi-session is opt-in; with the channel gate off every topic shares the
    // default session and there is nothing to route.
    settings.multiSession.channels.telegram = true;
    const active = createChatSession('unknown-sess-hub-other');
    setActiveChatSession(active.id);

    const target = {
        channel: 'telegram',
        targetKind: 'channel',
        peerKind: 'group',
        targetId: '-100777',
        threadId: '42',
    };

    // Give both sessions history so the compact has something to act on and the assertion
    // distinguishes which one it acted on.
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'active history', ?)").run(active.id);
    const remoteKey = 'jaw:telegram:group:-100777:thread:42';
    const preboundId = resolveOrCreateRemoteSession(remoteKey);
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'remote history', ?)").run(preboundId);

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/message', { prompt: '/compact', target });
        assert.equal(response.status, 200, await response.text());
    });

    const remoteSessionId = db.prepare('SELECT chat_session_id FROM remote_session_bindings WHERE remote_key LIKE ?')
        .pluck().get('jaw:telegram:group:-100777%') as string | undefined;
    assert.ok(remoteSessionId, 'the target must have resolved to its own session');
    const inRemote = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'").get(remoteSessionId) as { n: number };
    const inActive = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'").get(active.id) as { n: number };
    assert.equal(inRemote.n, 1, 'the compact acted on the remote conversation session');
    assert.equal(inActive.n, 0, 'the globally active session was left alone');
});

// With the channel gate off every topic shares the default session, and an ordinary
// targeted message is pinned to it. A slash command from the same topic must land in the
// same place, or it resets whichever local session happens to be active instead.
test('a targeted slash command with the channel gate off acts on the default session', async () => {
    settings.multiSession.enabled = true;
    settings.multiSession.channels.telegram = false;
    const active = createChatSession('unknown-sess-hub-gateoff');
    setActiveChatSession(active.id);
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'active history', ?)").run(active.id);
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'default history', 'default')").run();

    const target = { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100888', threadId: '7' };

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/message', { prompt: '/compact', target });
        assert.equal(response.status, 200, await response.text());
    });

    const inDefault = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 'default' AND role = 'assistant'").get() as { n: number };
    const inActive = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'").get(active.id) as { n: number };
    assert.equal(inDefault.n, 1, 'the compact acted on the default session');
    assert.equal(inActive.n, 0, 'the active local session was left alone');
});
