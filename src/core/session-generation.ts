// Persistent conversation generation — not the process-local spawn owner token.
//
// `src/agent/session-persistence.ts` tracks whether *this process* still owns a
// running spawn (`globalGeneration` / `scopeGenerations`). That dies with the
// process. This module is the integer that survives a restart, lives on
// `chat_sessions.generation`, and is what a stale /approve callback will be
// checked against in M4-A2. The two numbers must not be added, compared, or
// migrated into each other.

import type { Database as SqliteDatabase } from 'better-sqlite3';

export type SessionGenerationRef = Readonly<{ chatSessionId: string; conversationKey: string }>;

export type SessionGenerationBumpReason = 'new' | 'reset' | 'clear' | 'purge';

let database: SqliteDatabase | null = null;

export function initSessionGeneration(db: SqliteDatabase): void {
    database = db;
}

export function __resetSessionGenerationForTests(): void {
    database = null;
}

function requireDb(): SqliteDatabase {
    if (!database) throw new Error('session-generation: initSessionGeneration() has not run');
    return database;
}

function assertId(value: string, label: string): string {
    if (!value || typeof value !== 'string') throw new Error(`session-generation: ${label} is required`);
    return value;
}

export function readSessionGeneration(ref: SessionGenerationRef): number {
    const db = requireDb();
    const row = db.prepare(
        'SELECT generation FROM chat_sessions WHERE id = ?',
    ).get(assertId(ref.chatSessionId, 'chatSessionId')) as { generation: number } | undefined;
    if (!row) throw new Error(`session-generation: unknown session ${ref.chatSessionId}`);
    return row.generation;
}

export function isCurrentSessionGeneration(ref: SessionGenerationRef, expected: number): boolean {
    return readSessionGeneration(ref) === expected;
}

export function bumpSessionGeneration(ref: SessionGenerationRef, _reason: SessionGenerationBumpReason): number {
    const db = requireDb();
    const chatSessionId = assertId(ref.chatSessionId, 'chatSessionId');
    const run = db.transaction(() => {
        const row = db.prepare(
            'UPDATE chat_sessions SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING generation',
        ).get(chatSessionId) as { generation: number } | undefined;
        if (!row) throw new Error(`session-generation: unknown session ${chatSessionId}`);
        return row.generation;
    });
    return run.immediate();
}

/**
 * Point one conversation at a session and reset that session to generation 0.
 * `remote_session_bindings.chat_session_id` is UNIQUE, so a leftover binding on
 * the target session has to leave in the same transaction or the upsert throws
 * and two remotes would share one session.
 */
export function replaceRemoteSessionGeneration(
    conversationKey: string,
    nextChatSessionId: string,
): { generation: number } {
    const db = requireDb();
    const remoteKey = assertId(conversationKey, 'conversationKey');
    const nextId = assertId(nextChatSessionId, 'nextChatSessionId');
    const run = db.transaction(() => {
        const exists = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(nextId) as { id: string } | undefined;
        if (!exists) throw new Error(`session-generation: unknown session ${nextId}`);
        db.prepare(
            'DELETE FROM remote_session_bindings WHERE chat_session_id = ? AND remote_key != ?',
        ).run(nextId, remoteKey);
        db.prepare(`
            INSERT INTO remote_session_bindings (remote_key, chat_session_id)
            VALUES (?, ?)
            ON CONFLICT(remote_key) DO UPDATE SET
                chat_session_id = excluded.chat_session_id,
                last_seen_at = CURRENT_TIMESTAMP
        `).run(remoteKey, nextId);
        db.prepare(
            'UPDATE chat_sessions SET generation = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ).run(nextId);
        return { generation: 0 };
    });
    return run.immediate();
}
