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
        turn_id     TEXT DEFAULT NULL,
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

    CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        seq         INTEGER NOT NULL UNIQUE,
        label       TEXT DEFAULT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO chat_sessions (id, seq) VALUES ('default', 0);

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

    CREATE TABLE IF NOT EXISTS heartbeat_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id        TEXT,
        job_name      TEXT NOT NULL,
        origin        TEXT NOT NULL DEFAULT 'heartbeat',
        working_dir   TEXT,
        channel       TEXT,
        chat_id       TEXT,
        prompt        TEXT,
        output        TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        delivered_at  INTEGER,
        consumed_at   INTEGER,
        visible       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jaw_ceo_transcript (
        id          TEXT PRIMARY KEY,
        at          TEXT NOT NULL,
        role        TEXT NOT NULL,
        text        TEXT NOT NULL,
        source      TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_jaw_ceo_transcript_at ON jaw_ceo_transcript(at);

    CREATE TABLE IF NOT EXISTS trace_runs (
        id TEXT PRIMARY KEY,
        message_id INTEGER,
        parent_run_id TEXT,
        cli TEXT NOT NULL,
        model TEXT,
        working_dir TEXT,
        agent_label TEXT,
        audience TEXT NOT NULL DEFAULT 'public',
        status TEXT NOT NULL DEFAULT 'running',
        raw_retention_status TEXT NOT NULL DEFAULT 'available',
        event_count INTEGER NOT NULL DEFAULT 0,
        byte_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        last_event_at INTEGER,
        error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trace_runs_message ON trace_runs(message_id);
    CREATE INDEX IF NOT EXISTS idx_trace_runs_started ON trace_runs(started_at);

    CREATE TABLE IF NOT EXISTS trace_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        preview TEXT,
        raw_json TEXT,
        raw_path TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        retention_status TEXT NOT NULL DEFAULT 'available',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES trace_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_trace_events_run_seq ON trace_events(run_id, seq);

    CREATE TABLE IF NOT EXISTS turn_segments (
        turn_id TEXT NOT NULL,
        turn_seq INTEGER NOT NULL CHECK (turn_seq > 0),
        segment_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL DEFAULT 0,
        provider_at INTEGER,
        fidelity TEXT,
        thinking_marker TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        trace_run_id TEXT,
        trace_seq INTEGER,
        PRIMARY KEY (turn_id, turn_seq),
        CHECK (
            (trace_run_id IS NULL AND trace_seq IS NULL)
            OR (trace_run_id IS NOT NULL AND trace_seq > 0)
        )
    );
`);

// Keep additive upgrades compatible with any pre-release turn_segments schema.
const turnSegmentCols = db.prepare('PRAGMA table_info(turn_segments)').all() as Record<string, unknown>[];
if (!turnSegmentCols.some(c => c["name"] === 'type')) {
    db.exec("ALTER TABLE turn_segments ADD COLUMN type TEXT NOT NULL DEFAULT 'assistant_text'");
}
if (!turnSegmentCols.some(c => c["name"] === 'status')) {
    db.exec("ALTER TABLE turn_segments ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
}
if (!turnSegmentCols.some(c => c["name"] === 'trace_run_id')) {
    db.exec('ALTER TABLE turn_segments ADD COLUMN trace_run_id TEXT DEFAULT NULL');
}
if (!turnSegmentCols.some(c => c["name"] === 'trace_seq')) {
    db.exec('ALTER TABLE turn_segments ADD COLUMN trace_seq INTEGER DEFAULT NULL');
}
if (!turnSegmentCols.some(c => c["name"] === 'session_id')) {
    db.exec("ALTER TABLE turn_segments ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'");
}
if (!turnSegmentCols.some(c => c["name"] === 'created_at')) {
    db.exec('ALTER TABLE turn_segments ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
    db.prepare('UPDATE turn_segments SET created_at = ? WHERE created_at = 0').run(Date.now());
}
if (!turnSegmentCols.some(c => c["name"] === 'segment_id')) {
    db.exec("ALTER TABLE turn_segments ADD COLUMN segment_id TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE turn_segments SET segment_id = turn_id || ':' || turn_seq WHERE segment_id = ''");
}
if (!turnSegmentCols.some(c => c["name"] === 'observed_at')) {
    db.exec('ALTER TABLE turn_segments ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE turn_segments SET observed_at = created_at WHERE observed_at = 0');
}
if (!turnSegmentCols.some(c => c["name"] === 'provider_at')) {
    db.exec('ALTER TABLE turn_segments ADD COLUMN provider_at INTEGER DEFAULT NULL');
}
if (!turnSegmentCols.some(c => c["name"] === 'fidelity')) {
    db.exec('ALTER TABLE turn_segments ADD COLUMN fidelity TEXT DEFAULT NULL');
}
if (!turnSegmentCols.some(c => c["name"] === 'thinking_marker')) {
    db.exec('ALTER TABLE turn_segments ADD COLUMN thinking_marker TEXT DEFAULT NULL');
}
db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_segments_turn_seq
        ON turn_segments(turn_id, turn_seq);
    CREATE INDEX IF NOT EXISTS idx_turn_segments_trace_ref
        ON turn_segments(trace_run_id, trace_seq);
    CREATE INDEX IF NOT EXISTS idx_turn_segments_session_created
        ON turn_segments(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_turn_segments_created
        ON turn_segments(created_at);
    CREATE INDEX IF NOT EXISTS idx_turn_segments_lifecycle
        ON turn_segments(turn_id, segment_id, turn_seq);
`);

// Lightweight migration for existing DBs created before `trace` column existed.
const messageCols = db.prepare('PRAGMA table_info(messages)').all();
if (!(messageCols as Record<string, unknown>[]).some(c => c["name"] === 'trace')) {
    db.exec('ALTER TABLE messages ADD COLUMN trace TEXT DEFAULT NULL');
}
// Migration: add tool_log column for structured ProcessBlock data
if (!(messageCols as Record<string, unknown>[]).some(c => c["name"] === 'tool_log')) {
    db.exec('ALTER TABLE messages ADD COLUMN tool_log TEXT DEFAULT NULL');
}
// Migration: add working_dir column for project-scoped message isolation
if (!(messageCols as Record<string, unknown>[]).some(c => c["name"] === 'working_dir')) {
    db.exec('ALTER TABLE messages ADD COLUMN working_dir TEXT DEFAULT NULL');
}
if (!(messageCols as Record<string, unknown>[]).some(c => c["name"] === 'trace_run_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN trace_run_id TEXT DEFAULT NULL');
}
if (!(messageCols as Record<string, unknown>[]).some(c => c["name"] === 'turn_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN turn_id TEXT DEFAULT NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_wd ON messages(working_dir)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_trace_run ON messages(trace_run_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id)');

// Migration: add session_id column for multi-session message isolation
if (!(messageCols as Record<string, unknown>[]).some(c => c["name"] === 'session_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN session_id TEXT DEFAULT 'default'");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)');

// Migration: add active_chat_session to session table
const sessionCols = db.prepare('PRAGMA table_info(session)').all();
if (!(sessionCols as Record<string, unknown>[]).some(c => c["name"] === 'active_chat_session')) {
    db.exec("ALTER TABLE session ADD COLUMN active_chat_session TEXT DEFAULT 'default'");
}

const employeeSessionCols = db.prepare('PRAGMA table_info(employee_sessions)').all();
if (!(employeeSessionCols as Record<string, unknown>[]).some(c => c["name"] === 'model')) {
    db.exec("ALTER TABLE employee_sessions ADD COLUMN model TEXT DEFAULT ''");
}
if (!(employeeSessionCols as Record<string, unknown>[]).some(c => c["name"] === 'output_len')) {
    db.exec('ALTER TABLE employee_sessions ADD COLUMN output_len INTEGER DEFAULT 0');
}

const sessionBucketCols = db.prepare('PRAGMA table_info(session_buckets)').all();
if (!(sessionBucketCols as Record<string, unknown>[]).some(c => c["name"] === 'resume_key')) {
    db.exec('ALTER TABLE session_buckets ADD COLUMN resume_key TEXT DEFAULT NULL');
}
if (!(sessionBucketCols as Record<string, unknown>[]).some(c => c["name"] === 'output_len')) {
    db.exec('ALTER TABLE session_buckets ADD COLUMN output_len INTEGER DEFAULT 0');
}
// Frozen task snapshot per resume chain (#prompt-cache): regenerated only on
// fresh spawns, reused byte-identical across resume turns so the system
// prompt prefix stays cacheable. Dies with the bucket row on any clear.
if (!(sessionBucketCols as Record<string, unknown>[]).some(c => c["name"] === 'memory_snapshot')) {
    db.exec('ALTER TABLE session_buckets ADD COLUMN memory_snapshot TEXT DEFAULT NULL');
}
if (!(sessionBucketCols as Record<string, unknown>[]).some(c => c["name"] === 'last_run_clean')) db.exec('ALTER TABLE session_buckets ADD COLUMN last_run_clean INTEGER DEFAULT NULL');
if (!(sessionBucketCols as Record<string, unknown>[]).some(c => c["name"] === 'last_run_cwd')) db.exec('ALTER TABLE session_buckets ADD COLUMN last_run_cwd TEXT DEFAULT NULL');
if (!(sessionBucketCols as Record<string, unknown>[]).some(c => c["name"] === 'last_run_meta')) db.exec('ALTER TABLE session_buckets ADD COLUMN last_run_meta TEXT DEFAULT NULL');

// ─── Prepared Statements ─────────────────────────────

export const getSession = () => db.prepare('SELECT * FROM session WHERE id = ?').get('default');
export const updateSession = db.prepare(`
    UPDATE session SET active_cli=?, session_id=?, model=?, permissions=?, working_dir=?, effort=?, updated_at=CURRENT_TIMESTAMP
    WHERE id='default'
`);
// Background runtime hook tasks (src/bgtask/) — registration is durable so
// server restarts can recover watchers and re-deliver unsent notifications.
// Prepared statements live in src/bgtask/registry.ts (module-local).
db.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        spec          TEXT NOT NULL,
        status        TEXT NOT NULL,
        pid           INTEGER,
        origin_meta   TEXT,
        result        TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at    DATETIME,
        deadline_at   DATETIME,
        completed_at  DATETIME,
        notified_at   DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);
`);

export const insertMessage = db.prepare('INSERT INTO messages (role, content, cli, model, trace, working_dir, session_id) VALUES (?, ?, ?, ?, NULL, ?, ?)');
export const insertMessageWithTrace = db.prepare('INSERT INTO messages (role, content, cli, model, trace, tool_log, working_dir, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
export const insertMessageWithTraceRun = db.prepare('INSERT INTO messages (role, content, cli, model, trace, tool_log, working_dir, trace_run_id, session_id, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
export const getMessages = db.prepare('SELECT id, role, content, cli, model, tool_log, trace_run_id, turn_id, cost_usd, duration_ms, working_dir, created_at FROM messages WHERE session_id = ? ORDER BY id ASC');
export const searchMessages = db.prepare(`
    SELECT id, role, content, cli, tool_log, created_at,
           CASE WHEN content LIKE '%' || $q || '%' THEN 'content' ELSE 'tool_log' END AS match_field
    FROM messages
    WHERE (content LIKE '%' || $q || '%' OR tool_log LIKE '%' || $q || '%')
      AND session_id = $session_id
      AND ($days IS NULL OR created_at >= datetime('now', '-' || $days || ' days'))
      AND ($recent IS NULL OR id >= COALESCE(
        (SELECT id FROM messages WHERE session_id = $session_id ORDER BY id DESC LIMIT 1 OFFSET $recent),
        0
      ))
    ORDER BY id DESC
    LIMIT $limit
`);
export const getMessageContext = db.prepare(`
    SELECT id, role, content, cli, created_at
    FROM messages
    WHERE session_id = $session_id
      AND id BETWEEN ($target_id - $range) AND ($target_id + $range)
    ORDER BY id ASC
`);
export const searchMessagesByTimeWindow = db.prepare(`
    SELECT id, role, content, cli, created_at, session_id
    FROM messages
    WHERE created_at BETWEEN datetime($center, '-' || $window_hours || ' hours')
                        AND datetime($center, '+' || $window_hours || ' hours')
      AND (content LIKE '%' || $q || '%' OR ($q2 IS NOT NULL AND content LIKE '%' || $q2 || '%'))
    ORDER BY created_at DESC
    LIMIT $limit
`);
export const getMessagesWithTrace = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC');
// Recent-window variants: fetch the most recent N rows (DESC + LIMIT) to keep the
// chat boot payload bounded. Callers reverse the result back to ascending order.
export const getRecentMessagesAll = db.prepare('SELECT id, role, content, cli, model, tool_log, trace_run_id, turn_id, cost_usd, duration_ms, working_dir, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');
export const getRecentMessagesAllWithTrace = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');
export const getRecentMessagesBefore = db.prepare('SELECT id, role, content, cli, model, tool_log, trace_run_id, turn_id, cost_usd, duration_ms, working_dir, created_at FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?');
export const getRecentMessagesBeforeWithTrace = db.prepare('SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?');
export const hasMessagesBefore = db.prepare('SELECT EXISTS(SELECT 1 FROM messages WHERE session_id = ? AND id < ?) AS present');
export const getMessageCount = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?');
export const getLatestAssistantMessage = db.prepare("SELECT id, role, content, created_at FROM messages WHERE role = 'assistant' AND session_id = ? ORDER BY id DESC LIMIT 1");
export const getLatestDashboardActivityMessage = db.prepare("SELECT id, role, substr(content, 1, 240) AS excerpt, created_at FROM messages WHERE role IN ('user', 'assistant') AND session_id = ? ORDER BY id DESC LIMIT 1");
export const getRecentMessages = db.prepare('SELECT id, role, content, cli, model, trace, tool_log, created_at FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? ORDER BY id DESC LIMIT ?');
// Lightweight variant for per-turn callers that only read {role, content}.
// Avoids loading the heavy trace/tool_log blobs that getRecentMessages carries.
export const getRecentMessagesLite = db.prepare('SELECT role, content FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? ORDER BY id DESC LIMIT ?');
export const getRecentToolLogs = db.prepare('SELECT id, tool_log, created_at FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? AND tool_log IS NOT NULL AND tool_log != \'\' ORDER BY id DESC LIMIT ?');
export const clearMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
export const clearMessagesBySession = db.prepare('DELETE FROM messages WHERE session_id = ?');
export const clearMessagesScoped = db.prepare('DELETE FROM messages WHERE working_dir = ? AND session_id = ?');
export const insertJawCeoTranscript = db.prepare('INSERT OR REPLACE INTO jaw_ceo_transcript (id, at, role, text, source) VALUES (?, ?, ?, ?, ?)');
export const getJawCeoTranscript = db.prepare('SELECT id, at, role, text, source FROM jaw_ceo_transcript ORDER BY at DESC, created_at DESC LIMIT ?');
export const pruneJawCeoTranscript = db.prepare('DELETE FROM jaw_ceo_transcript WHERE id NOT IN (SELECT id FROM jaw_ceo_transcript ORDER BY at DESC, created_at DESC LIMIT ?)');
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
    'INSERT OR REPLACE INTO employee_sessions (employee_id, session_id, cli, model, output_len) VALUES (?, ?, ?, ?, ?)'
);
export const clearEmployeeSession = db.prepare('DELETE FROM employee_sessions WHERE employee_id = ?');
export const clearAllEmployeeSessions = db.prepare('DELETE FROM employee_sessions');

// ─── Session Buckets (per-bucket resume storage) ─────
export const getSessionBucket = db.prepare('SELECT bucket, session_id, model, resume_key, output_len, memory_snapshot, updated_at, last_run_clean, last_run_cwd, last_run_meta FROM session_buckets WHERE bucket = ?');
export const upsertSessionBucket = db.prepare(`
    INSERT INTO session_buckets (bucket, session_id, model, resume_key, output_len, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(bucket) DO UPDATE SET
        session_id=excluded.session_id,
        model=excluded.model,
        resume_key=excluded.resume_key,
        output_len=excluded.output_len,
        updated_at=CURRENT_TIMESTAMP
`);
// Frozen snapshot write happens at spawn time, before the turn's session id
// exists — the placeholder row ('' session_id stays falsy for resume checks)
// is later completed by upsertSessionBucket, whose DO UPDATE intentionally
// leaves memory_snapshot untouched. updated_at is NOT bumped on conflict so
// a forceNew snapshot write cannot extend a stale bucket's resume TTL.
export const setSessionBucketSnapshot = db.prepare(`
    INSERT INTO session_buckets (bucket, session_id, model, memory_snapshot)
    VALUES (?, '', ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET memory_snapshot=excluded.memory_snapshot
`);
export const clearSessionBucket = db.prepare('DELETE FROM session_buckets WHERE bucket = ?');
export const updateSessionBucketLastRun = db.prepare('UPDATE session_buckets SET last_run_clean=?, last_run_cwd=?, last_run_meta=? WHERE bucket=?');

// ─── Message Queue Persistence ──────────────────────
export const listQueuedMessages = db.prepare('SELECT id, payload FROM queued_messages ORDER BY created_at ASC');
export const insertQueuedMessage = db.prepare('INSERT OR REPLACE INTO queued_messages (id, payload) VALUES (?, ?)');
export const deleteQueuedMessage = db.prepare('DELETE FROM queued_messages WHERE id = ?');
export const clearQueuedMessages = db.prepare('DELETE FROM queued_messages');

// ─── Heartbeat Anchor Persistence ───────────────────
export const insertHeartbeatAnchor = db.prepare(
    `INSERT INTO heartbeat_events (job_id, job_name, working_dir, channel, chat_id, prompt, output, created_at, delivered_at, visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
);
export const getLatestUnconsumedAnchor = db.prepare(
    `SELECT * FROM heartbeat_events
     WHERE working_dir = ? AND consumed_at IS NULL AND visible = 1
     ORDER BY created_at DESC LIMIT 1`
);
export const markAnchorConsumed = db.prepare(
    `UPDATE heartbeat_events SET consumed_at = ? WHERE id = ?`
);
export const getUnconsumedAnchors = db.prepare(
    `SELECT id, job_name, output, created_at FROM heartbeat_events
     WHERE consumed_at IS NULL AND visible = 1`
);

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
    "UPDATE orc_state SET state = 'IDLE', ctx = NULL WHERE state != 'IDLE' AND updated_at < datetime('now', '-24 hours')"
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
