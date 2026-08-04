import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import { db } from '../../src/core/db.ts';
import {
    getActiveChatSession,
    resolveOrCreateRemoteSession,
    setActiveChatSession,
} from '../../src/core/chat-sessions.ts';
import { withSessionScope } from '../../src/core/session-context.ts';

afterEach(() => {
    settings.multiSession = { enabled: false };
    db.exec('DROP TRIGGER IF EXISTS fail_remote_binding_insert');
    db.prepare("DELETE FROM remote_session_bindings WHERE remote_key LIKE 'jaw:test:%'").run();
    db.prepare("DELETE FROM chat_sessions WHERE label LIKE 'jaw:test:%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
});

test('binding miss creates one session and binding atomically; hit reuses it', () => {
    settings.multiSession = { enabled: true };
    const remoteKey = 'jaw:test:channel:A';

    const firstId = resolveOrCreateRemoteSession(remoteKey);
    const firstSession = db.prepare('SELECT id, label FROM chat_sessions WHERE id = ?').get(firstId) as { id: string; label: string };
    const firstBinding = db.prepare('SELECT chat_session_id FROM remote_session_bindings WHERE remote_key = ?').get(remoteKey) as { chat_session_id: string };
    assert.deepEqual(firstSession, { id: firstId, label: remoteKey });
    assert.equal(firstBinding.chat_session_id, firstId);

    const secondId = resolveOrCreateRemoteSession(remoteKey);
    assert.equal(secondId, firstId);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_sessions WHERE label = ?').get(remoteKey) as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM remote_session_bindings WHERE remote_key = ?').get(remoteKey) as { count: number }).count, 1);
});

test('binding insert failure rolls back the chat session row', () => {
    settings.multiSession = { enabled: true };
    const remoteKey = 'jaw:test:fail';
    db.exec(`
        CREATE TRIGGER fail_remote_binding_insert
        BEFORE INSERT ON remote_session_bindings
        WHEN NEW.remote_key = '${remoteKey}'
        BEGIN
            SELECT RAISE(ABORT, 'forced binding failure');
        END;
    `);

    assert.throws(() => resolveOrCreateRemoteSession(remoteKey), /forced binding failure/);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_sessions WHERE label = ?').get(remoteKey) as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM remote_session_bindings WHERE remote_key = ?').get(remoteKey) as { count: number }).count, 0);
});

test('remote switch updates only its binding and session delete cascades', () => {
    settings.multiSession = { enabled: true };
    const remoteKey = 'jaw:test:channel:B';
    const originalRemoteSession = resolveOrCreateRemoteSession(remoteKey);
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('local-next', 999, 'local')").run();

    withSessionScope({ scope: remoteKey, chatSessionId: originalRemoteSession }, () => {
        assert.equal(getActiveChatSession(), originalRemoteSession);
        setActiveChatSession('local-next');
    });

    assert.equal(getActiveChatSession(), 'default');
    assert.equal(
        (db.prepare('SELECT chat_session_id FROM remote_session_bindings WHERE remote_key = ?').get(remoteKey) as { chat_session_id: string }).chat_session_id,
        'local-next',
    );
    db.prepare("DELETE FROM chat_sessions WHERE id = 'local-next'").run();
    assert.equal(db.prepare('SELECT 1 FROM remote_session_bindings WHERE remote_key = ?').get(remoteKey), undefined);
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(originalRemoteSession);
});
