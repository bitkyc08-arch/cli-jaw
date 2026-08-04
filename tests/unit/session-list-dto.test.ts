import '../setup/isolated-home.ts';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { listChatSessions, setSessionRunPolicy } from '../../src/core/chat-sessions.ts';
import { settings } from '../../src/core/config.ts';

const IDS = ['dto-local', 'dto-slack', 'dto-empty'];

beforeEach(() => {
    settings.multiSession.enabled = true;
    for (const id of IDS) {
        db.prepare('INSERT INTO chat_sessions (id, seq, label) VALUES (?, ?, ?)').run(id, 900 + IDS.indexOf(id), id);
    }
    db.prepare('INSERT INTO remote_session_bindings (remote_key, chat_session_id) VALUES (?, ?)')
        .run('jaw:slack:channel:C071', 'dto-slack');
    db.prepare('INSERT INTO messages (role, content, created_at, session_id) VALUES (?, ?, ?, ?)')
        .run('user', 'older', '2026-08-01 01:00:00', 'dto-local');
    db.prepare('INSERT INTO messages (role, content, created_at, session_id) VALUES (?, ?, ?, ?)')
        .run('assistant', 'newer', '2026-08-02 02:00:00', 'dto-local');
});

afterEach(() => {
    db.prepare(`DELETE FROM messages WHERE session_id IN (${IDS.map(() => '?').join(',')})`).run(...IDS);
    db.prepare(`DELETE FROM remote_session_bindings WHERE chat_session_id IN (${IDS.map(() => '?').join(',')})`).run(...IDS);
    db.prepare(`DELETE FROM chat_sessions WHERE id IN (${IDS.map(() => '?').join(',')})`).run(...IDS);
    settings.multiSession.enabled = false;
});

test('ON DTO derives source, remoteKey, last message activity, and zero-message values', () => {
    const rows = listChatSessions();
    const local = rows.find(row => row.id === 'dto-local');
    const slack = rows.find(row => row.id === 'dto-slack');
    const empty = rows.find(row => row.id === 'dto-empty');

    assert.deepEqual(local && {
        source: local.source,
        remoteKey: local.remoteKey,
        message_count: local.message_count,
        lastActivityAt: local.lastActivityAt,
    }, {
        source: 'local', remoteKey: null, message_count: 2, lastActivityAt: '2026-08-02 02:00:00',
    });
    assert.equal(slack?.source, 'slack');
    assert.equal(slack?.remoteKey, 'jaw:slack:channel:C071');
    assert.equal(empty?.message_count, 0);
    assert.equal(empty?.lastActivityAt, null);
});

test('run-policy updates do not move lastActivityAt', () => {
    const before = listChatSessions().find(row => row.id === 'dto-local')?.lastActivityAt;
    setSessionRunPolicy('dto-local', 'collect');
    const after = listChatSessions().find(row => row.id === 'dto-local')?.lastActivityAt;
    assert.equal(after, before);
    assert.equal(after, '2026-08-02 02:00:00');
});

test('OFF DTO preserves the exact legacy key set', () => {
    settings.multiSession.enabled = false;
    const row = listChatSessions().find(item => item.id === 'dto-local');
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), [
        'active_run_policy', 'created_at', 'id', 'label', 'message_count', 'seq', 'updated_at',
    ]);
});
