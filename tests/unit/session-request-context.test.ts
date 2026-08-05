import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { createChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { resolveRequestSession } from '../../src/routes/session-request.ts';

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

    const resolved = resolveRequestSession(viewed.id);
    assert.equal(resolved.chatSessionId, viewed.id);
    assert.equal(resolved.scope, `local:${viewed.id}`);
});

test('no session named falls back to the active one', () => {
    settings.multiSession.enabled = true;
    const active = createChatSession('req-ctx-fallback');
    setActiveChatSession(active.id);

    for (const raw of [undefined, '', '   ', 42, null]) {
        const resolved = resolveRequestSession(raw);
        assert.equal(resolved.chatSessionId, active.id, `${String(raw)} must fall back`);
    }
});

// A tab racing a deletion should not lose the message the user just typed.
test('an unknown session id falls back instead of failing', () => {
    settings.multiSession.enabled = true;
    const active = createChatSession('req-ctx-unknown');
    setActiveChatSession(active.id);

    const resolved = resolveRequestSession('req-does-not-exist');
    assert.equal(resolved.chatSessionId, active.id);
});

test('with multi-session off a named session cannot redirect the write', () => {
    settings.multiSession.enabled = true;
    const other = createChatSession('req-ctx-gateoff');
    setActiveChatSession('default');
    settings.multiSession.enabled = false;

    const resolved = resolveRequestSession(other.id);
    assert.equal(resolved.chatSessionId, 'default');
    assert.equal(resolved.scope, 'default');
});

test('the default session keeps the default scope', () => {
    settings.multiSession.enabled = true;
    const resolved = resolveRequestSession('default');
    assert.equal(resolved.chatSessionId, 'default');
    assert.equal(resolved.scope, 'default');
});

test('a remotely bound session resolves to its remote scope, not a local one', () => {
    settings.multiSession.enabled = true;
    const bound = createChatSession('req-ctx-remote');
    db.prepare('INSERT INTO remote_session_bindings (remote_key, chat_session_id) VALUES (?, ?)')
        .run('jaw:slack:channel:C9', bound.id);

    const resolved = resolveRequestSession(bound.id);
    assert.equal(resolved.chatSessionId, bound.id);
    assert.equal(resolved.scope, 'jaw:slack:channel:C9');
    assert.equal(resolved.remoteKey, 'jaw:slack:channel:C9');
});
