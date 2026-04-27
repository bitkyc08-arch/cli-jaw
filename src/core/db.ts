// ─── Database: schema + prepared statements ──────────

import Database from 'better-sqlite3';
import fs from 'fs';
import { dirname } from 'path';
import { DB_PATH } from './config.js';

function ensureDbDirExists(dbPath: string) {
    const dbDir = dirname(dbPath);
    if (!dbDir) return;
    fs.mkdirSync(dbDir, { recursive: true });
}

function checkOrphanedWal(dbPath: string) {
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (!fs.existsSync(dbPath) && (fs.existsSync(walPath) || fs.existsSync(shmPath))) {
        console.error('[db] ⚠️  WARNING: WAL/SHM files exist without main DB. Cleaning orphaned files.');
        try { fs.unlinkSync(walPath); } catch { /* ignore */ }
        try { fs.unlinkSync(shmPath); } catch { /* ignore */ }
    }
}

ensureDbDirExists(DB_PATH);
checkOrphanedWal(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS session (
        id          TEXT PRIMARY KEY DEFAULT 'default',
        active_cli  TEXT DEFAULT 'claude',
        session_id  TEXT,
        model       TEXT DEFAULT 'default',
        permissions TEXT DEFAULT 'auto',
        working_dir TEXT DEFAULT '~',
        effort      TEXT DEFAULT 'medium',
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO session (id) VALUES ('default');

    CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        cli         TEXT,
        model       TEXT,
        trace       TEXT DEFAULT NULL,
        cost_usd    REAL,
        duration_ms INTEGER,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        value       TEXT NOT NULL,
        source      TEXT DEFAULT 'manual',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employees (
        id          TEXT PRIMARY KEY,
        name        TEXT DEFAULT 'New Agent',
        cli         TEXT DEFAULT 'claude',
        model       TEXT DEFAULT 'default',
        role        TEXT DEFAULT '',
        status      TEXT DEFAULT 'idle',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employee_sessions (
        employee_id TEXT PRIMARY KEY,
        session_id  TEXT,
        cli         TEXT,
        model       TEXT DEFAULT '',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orc_state (
        id         TEXT PRIMARY KEY DEFAULT 'default',
        state      TEXT DEFAULT 'IDLE',
        ctx        TEXT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO orc_state (id) VALUES ('default');

    CREATE TABLE IF NOT EXISTS queued_messages (
        id         TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-bucket resumable session storage. Bucket key is a stable CLI+model-family
    -- identifier (e.g. 'codex', 'codex-spark', 'claude'). Prevents cross-model resume
    -- errors like 'thread/resume failed: no rollout found' when the user toggles
    -- between gpt-5.4 and gpt-5.3-codex-spark on the same codex CLI.
    CREATE TABLE IF NOT EXISTS session_buckets (
        bucket      TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        model       TEXT NOT NULL,
        resume_key  TEXT DEFAULT NULL,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Lightweight migration for existing DBs created before `trace` column existed.
const messageCols = db.prepare('PRAGMA table_info(messages)').all();
if (!(messageCols as Record<string, unknown>[]).some(c => c.name === 'trace')) {
    db.exec('ALTER TABLE messages ADD COLUMN trace TEXT DEFAULT NULL');
}
// Migration: add tool_log column for structured ProcessBlock data
if (!(messageCols as Record<string, unknown>[]).some(c => c.name === 'tool_log')) {
    db.exec('ALTER TABLE messages ADD COLUMN tool_log TEXT DEFAULT NULL');
}
// Migration: add working_dir column for project-scoped message isolation
if (!(messageCols as Record<string, unknown>[]).some(c => c.name === 'working_dir')) {
    db.exec('ALTER TABLE messages ADD COLUMN working_dir TEXT DEFAULT NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_wd ON messages(working_dir)');

const employeeSessionCols = db.prepare('PRAGMA table_info(employee_sessions)').all();
if (!(employeeSessionCols as Record<string, unknown>[]).some(c => c.name === 'model')) {
    db.exec("ALTER TABLE employee_sessions ADD COLUMN model TEXT DEFAULT ''");
}

const sessionBucketCols = db.prepare('PRAGMA table_info(session_buckets)').all();
if (!(sessionBucketCols as Record<string, unknown>[]).some(c => c.name === 'resume_key')) {
    db.exec('ALTER TABLE session_buckets ADD COLUMN resume_key TEXT DEFAULT NULL');
}

// ─── Prepared Statements ─────────────────────────────

export const getSession = () => db.prepare('SELECT * FROM session WHERE id = ?').get('default');
export const updateSession = db.prepare(`
    UPDATE session SET active_cli=?, session_id=?, model=?, permissions=?, working_dir=?, effort=?, updated_at=CURRENT_TIMESTAMP
    WHERE id='default'
`);
export const insertMessage = db.prepare('INSERT INTO messages (role, content, cli, model, trace, working_dir) VALUES (?, ?, ?, ?, NULL, ?)');
export const insertMessageWithTrace = db.prepare('INSERT INTO messages (role, content, cli, model, trace, tool_log, working_dir) VALUES (?, ?, ?, ?, ?, ?, ?)');
export const getMessages = db.prepare('SELECT id, role, content, cli, model, tool_log, cost_usd, duration_ms, working_dir, created_at FROM messages ORDER BY id ASC');
export const getMessagesWithTrace = db.prepare('SELECT * FROM messages ORDER BY id ASC');
export const getRecentMessages = db.prepare('SELECT id, role, content, cli, model, trace, created_at FROM messages WHERE working_dir = ? OR working_dir IS NULL ORDER BY id DESC LIMIT ?');
export const clearMessages = db.prepare('DELETE FROM messages');
export const clearMessagesScoped = db.prepare('DELETE FROM messages WHERE working_dir = ?');
export const getMemory = db.prepare('SELECT key, value, source FROM memory ORDER BY updated_at DESC');
export const upsertMemory = db.prepare(`
    INSERT INTO memory (key, value, source) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=CURRENT_TIMESTAMP
`);
export const deleteMemory = db.prepare('DELETE FROM memory WHERE key = ?');
export const getEmployees = db.prepare('SELECT * FROM employees ORDER BY created_at ASC');
export const insertEmployee = db.prepare('INSERT INTO employees (id, name, cli, model, role) VALUES (?, ?, ?, ?, ?)');
export const deleteEmployee = db.prepare('DELETE FROM employees WHERE id = ?');
export const getEmployeeSession = db.prepare('SELECT * FROM employee_sessions WHERE employee_id = ?');
export const upsertEmployeeSession = db.prepare(
    'INSERT OR REPLACE INTO employee_sessions (employee_id, session_id, cli, model) VALUES (?, ?, ?, ?)'
);
export const clearEmployeeSession = db.prepare('DELETE FROM employee_sessions WHERE employee_id = ?');
export const clearAllEmployeeSessions = db.prepare('DELETE FROM employee_sessions');

// ─── Session Buckets (per-bucket resume storage) ─────
export const getSessionBucket = db.prepare('SELECT bucket, session_id, model, resume_key, updated_at FROM session_buckets WHERE bucket = ?');
export const upsertSessionBucket = db.prepare(`
    INSERT INTO session_buckets (bucket, session_id, model, resume_key, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(bucket) DO UPDATE SET
        session_id=excluded.session_id,
        model=excluded.model,
        resume_key=excluded.resume_key,
        updated_at=CURRENT_TIMESTAMP
`);
export const clearSessionBucket = db.prepare('DELETE FROM session_buckets WHERE bucket = ?');

// ─── Message Queue Persistence ──────────────────────
export const listQueuedMessages = db.prepare('SELECT id, payload FROM queued_messages ORDER BY created_at ASC');
export const insertQueuedMessage = db.prepare('INSERT OR REPLACE INTO queued_messages (id, payload) VALUES (?, ?)');
export const deleteQueuedMessage = db.prepare('DELETE FROM queued_messages WHERE id = ?');
export const clearQueuedMessages = db.prepare('DELETE FROM queued_messages');

// ─── PABCD State Machine ────────────────────────────
export const getOrcState = db.prepare(
    'SELECT * FROM orc_state WHERE id = ?',
);

export const setOrcState = db.prepare(`
    INSERT INTO orc_state (id, state, ctx, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        ctx = excluded.ctx,
        updated_at = CURRENT_TIMESTAMP
`);

export const resetOrcState = db.prepare(`
    INSERT INTO orc_state (id, state, ctx, updated_at)
    VALUES (?, 'IDLE', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
        state = 'IDLE',
        ctx = NULL,
        updated_at = CURRENT_TIMESTAMP
`);

export const listActiveOrcStates = db.prepare(
    "SELECT id, state, ctx, updated_at FROM orc_state WHERE state != 'IDLE'"
);

export const resetAllOrcStates = db.prepare(
    "UPDATE orc_state SET state = 'IDLE', ctx = NULL WHERE state != 'IDLE'"
);

export const deleteNonDefaultOrcStates = db.prepare(
    "DELETE FROM orc_state WHERE id != 'default'"
);

/** Checkpoint WAL and close the database. Call once during graceful shutdown. */
export function closeDb(): void {
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* ignore if already closed */ }
    try {
        db.close();
    } catch { /* ignore */ }
}

export { db };
