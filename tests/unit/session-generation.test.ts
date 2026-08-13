// Persistent chat_sessions.generation (M4-A0).
//
// Orthogonal to src/agent/session-persistence.ts process-local owner tokens.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
    bumpSessionGeneration,
    initSessionGeneration,
    isCurrentSessionGeneration,
    readSessionGeneration,
    replaceRemoteSessionGeneration,
    __resetSessionGenerationForTests,
} from '../../src/core/session-generation.ts';

function schema(database: Database.Database): void {
    database.pragma('foreign_keys = ON');
    database.exec(`
        CREATE TABLE chat_sessions (
            id TEXT PRIMARY KEY,
            seq INTEGER NOT NULL UNIQUE,
            label TEXT,
            active_run_policy TEXT,
            generation INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE remote_session_bindings (
            remote_key TEXT PRIMARY KEY,
            chat_session_id TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        );
    `);
}

function seeded() {
    const database = new Database(':memory:');
    schema(database);
    database.prepare("INSERT INTO chat_sessions (id, seq) VALUES ('s1', 1), ('s2', 2)").run();
    initSessionGeneration(database);
    return database;
}

test.afterEach(() => {
    __resetSessionGenerationForTests();
});

test('fresh and upgraded sessions expose generation 0', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
        CREATE TABLE chat_sessions (
            id TEXT PRIMARY KEY,
            seq INTEGER NOT NULL UNIQUE,
            label TEXT,
            active_run_policy TEXT
        );
        INSERT INTO chat_sessions (id, seq) VALUES ('old', 1);
    `);
    const cols = legacy.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'generation')) {
        legacy.exec('ALTER TABLE chat_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    }
    const row = legacy.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get('old') as { generation: number };
    assert.equal(row.generation, 0);
    legacy.close();

    const database = seeded();
    assert.equal(readSessionGeneration({ chatSessionId: 's1', conversationKey: 'c' }), 0);
    database.close();
});

test('bumps serialize to distinct increasing integers', () => {
    const database = seeded();
    const ref = { chatSessionId: 's1', conversationKey: 'conv:1' };
    const first = bumpSessionGeneration(ref, 'reset');
    const second = bumpSessionGeneration(ref, 'clear');
    assert.equal(first, 1);
    assert.equal(second, 2);
    assert.equal(isCurrentSessionGeneration(ref, 1), false);
    assert.equal(isCurrentSessionGeneration(ref, 2), true);
    database.close();
});

test('replaceRemoteSessionGeneration rebinds without UNIQUE collision', () => {
    const database = seeded();
    database.prepare("INSERT INTO remote_session_bindings (remote_key, chat_session_id) VALUES ('conv:A', 's2'), ('conv:C', 's1')").run();
    bumpSessionGeneration({ chatSessionId: 's2', conversationKey: 'conv:A' }, 'reset');
    assert.equal(readSessionGeneration({ chatSessionId: 's2', conversationKey: 'conv:A' }), 1);

    const result = replaceRemoteSessionGeneration('conv:C', 's2');
    assert.equal(result.generation, 0);
    assert.equal(readSessionGeneration({ chatSessionId: 's2', conversationKey: 'conv:C' }), 0);
    assert.equal(readSessionGeneration({ chatSessionId: 's1', conversationKey: 'conv:C' }), 0);

    const rows = database.prepare('SELECT remote_key, chat_session_id FROM remote_session_bindings ORDER BY remote_key').all() as Array<{ remote_key: string; chat_session_id: string }>;
    assert.deepEqual(rows, [{ remote_key: 'conv:C', chat_session_id: 's2' }]);
    database.close();
});
