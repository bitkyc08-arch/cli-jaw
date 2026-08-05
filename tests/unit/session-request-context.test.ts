import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { createChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { resolveRequestSessionStrict } from '../../src/routes/session-request.ts';

function resolved(raw: unknown) {
    const result = resolveRequestSessionStrict(raw);
    assert.equal(result.ok, true, 'expected the session to resolve');
    return result as Extract<typeof result, { ok: true }>;
}

afterEach(() => {
    db.prepare("DELETE FROM remote_session_bindings WHERE chat_session_id LIKE 'req-%'").run();
    db.prepare("DELETE FROM chat_sessions WHERE label LIKE 'req-ctx%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    settings.multiSession.enabled = false;
});

// 072 §1.1 — a tab on /:seq must write to the session it is looking at, not to
// whatever session happens to be globally active.

test('a named session wins over the globally active one', () => {
    settings.multiSession.enabled = true;
    const viewed = createChatSession('req-ctx-viewed');
    const active = createChatSession('req-ctx-active');
    setActiveChatSession(active.id);

    const context = resolved(viewed.id);
    assert.equal(context.chatSessionId, viewed.id);
    assert.equal(context.scope, `local:${viewed.id}`);
});

test('no session named falls back to the active one', () => {
    settings.multiSession.enabled = true;
    const active = createChatSession('req-ctx-fallback');
    setActiveChatSession(active.id);

    for (const raw of [undefined, '', '   ', 42, null]) {
        assert.equal(resolved(raw).chatSessionId, active.id, `${String(raw)} must fall back`);
    }
});

// Falling back here would write one tab's message into a different session: tab A views
// X, X is deleted, another tab makes Y active, and A's next send lands in Y.
test('a named session that no longer exists fails instead of redirecting the write', () => {
    settings.multiSession.enabled = true;
    const active = createChatSession('req-ctx-unknown');
    setActiveChatSession(active.id);

    const result = resolveRequestSessionStrict('req-does-not-exist');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unknown_session');
    assert.equal(result.ok === false && result.requested, 'req-does-not-exist');
});

test('with multi-session off a named session cannot redirect the write', () => {
    settings.multiSession.enabled = true;
    const other = createChatSession('req-ctx-gateoff');
    setActiveChatSession('default');
    settings.multiSession.enabled = false;

    const context = resolved(other.id);
    assert.equal(context.chatSessionId, 'default');
    assert.equal(context.scope, 'default');
});

// With the gate off there are no per-session semantics to protect, and an old client
// sending a stale id must not start getting 404s it never got before.
test('with multi-session off an unknown id is not an error', () => {
    settings.multiSession.enabled = false;
    assert.equal(resolved('req-does-not-exist').chatSessionId, 'default');
});

test('the default session keeps the default scope', () => {
    settings.multiSession.enabled = true;
    const context = resolved('default');
    assert.equal(context.chatSessionId, 'default');
    assert.equal(context.scope, 'default');
});

test('a remotely bound session resolves to its remote scope, not a local one', () => {
    settings.multiSession.enabled = true;
    const bound = createChatSession('req-ctx-remote');
    db.prepare('INSERT INTO remote_session_bindings (remote_key, chat_session_id) VALUES (?, ?)')
        .run('jaw:slack:channel:C9', bound.id);

    const context = resolved(bound.id);
    assert.equal(context.chatSessionId, bound.id);
    assert.equal(context.scope, 'jaw:slack:channel:C9');
    assert.equal(context.remoteKey, 'jaw:slack:channel:C9');
});
