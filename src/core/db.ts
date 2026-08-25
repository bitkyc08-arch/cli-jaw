// ─── Database: schema + prepared statements ──────────

import Database from 'better-sqlite3';
import { initSessionGeneration } from './session-generation.js';
import fs from 'fs';
import { dirname } from 'path';
import { DB_PATH } from './config.js';
import { stripStallTruncationNotice } from '../agent/stall-notice.js';

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
db.pragma('foreign_keys = ON');

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

    CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        seq         INTEGER NOT NULL UNIQUE,
        label       TEXT DEFAULT NULL,
        active_run_policy TEXT DEFAULT NULL,
        generation  INTEGER NOT NULL DEFAULT 0,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO chat_sessions (id, seq) VALUES ('default', 0);

    CREATE TABLE IF NOT EXISTS remote_session_bindings (
        remote_key      TEXT PRIMARY KEY,
        chat_session_id TEXT NOT NULL UNIQUE,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_remote_bindings_chat_session
        ON remote_session_bindings(chat_session_id);

    CREATE TABLE IF NOT EXISTS queued_messages (
        id         TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- #321: "already handled" has to survive a restart, because "still to
    -- handle" does. The queue above is durable while the ingress dedupe was
    -- process memory, so a reconnect before Slack observed our ACK could admit
    -- the same delivery twice under the next lifecycle. Rows are written only
    -- AFTER a run is admitted and expire on the same 10-minute redelivery
    -- horizon as the in-memory map.
    CREATE TABLE IF NOT EXISTS slack_event_dedup (
        event_key  TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
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
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_wd ON messages(working_dir)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_trace_run ON messages(trace_run_id)');

// Migration: add session_id column for multi-session message isolation
if (!(messageCols as Record<string, unknown>[]).some(c => c["name"] === 'session_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN session_id TEXT DEFAULT 'default'");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)');

const SEARCH_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, tool_log, session_id UNINDEXED,
    content='messages', content_rowid='id', tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_trigram USING fts5(
    content, tool_log, session_id UNINDEXED,
    content='messages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_search_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
    INSERT INTO messages_trigram(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_search_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
    INSERT INTO messages_trigram(messages_trigram, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_search_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
    INSERT INTO messages_fts(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
    INSERT INTO messages_trigram(messages_trigram, rowid, content, tool_log, session_id)
    VALUES ('delete', old.id, old.content, COALESCE(old.tool_log, ''), old.session_id);
    INSERT INTO messages_trigram(rowid, content, tool_log, session_id)
    VALUES (new.id, new.content, COALESCE(new.tool_log, ''), new.session_id);
END;
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
INSERT INTO messages_trigram(messages_trigram) VALUES('rebuild');
`;

function hasSearchFts(database: Database.Database, name: string): boolean {
    return Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name));
}

const SEARCH_FTS_TRIGGERS = ['messages_search_ai', 'messages_search_ad', 'messages_search_au'] as const;

function hasSearchTrigger(database: Database.Database, name: string): boolean {
    return Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(name));
}

/**
 * The tables alone are not a usable index. If a trigger is missing — an
 * interrupted upgrade, a restored dump, a manual DROP — the tables still exist
 * while new messages never reach them, so search silently returns stale
 * results. Probe the whole schema, not just the tables.
 */
function searchFtsSchemaComplete(database: Database.Database): boolean {
    return hasSearchFts(database, 'messages_fts')
        && hasSearchFts(database, 'messages_trigram')
        && SEARCH_FTS_TRIGGERS.every(name => hasSearchTrigger(database, name));
}

/** Create and verify the external-content chat indexes without version metadata. */
export function migrateSearchFts(database: Database.Database): boolean {
    if (searchFtsSchemaComplete(database)) return true;
    try {
        database.transaction(() => {
            database.exec(SEARCH_FTS_SQL);
            const sentinel = `jaw_fts_probe_${Date.now()}_xyz`;
            const inserted = database.prepare(
                "INSERT INTO messages(role, content, session_id) VALUES('system', ?, 'fts-migration-probe')",
            ).run(sentinel);
            const rowid = Number(inserted.lastInsertRowid);
            const match = `"${sentinel}"`;
            const unicodeHit = database.prepare(
                'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid=?',
            ).get(match, rowid);
            const trigramHit = database.prepare(
                'SELECT rowid FROM messages_trigram WHERE messages_trigram MATCH ? AND rowid=?',
            ).get(match, rowid);
            if (!unicodeHit || !trigramHit) throw new Error('search FTS MATCH probe failed');
            database.prepare(
                "INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
            ).run();
            database.prepare(
                "INSERT INTO messages_trigram(messages_trigram, rank) VALUES('integrity-check', 1)",
            ).run();
            database.prepare('DELETE FROM messages WHERE id=?').run(rowid);
        })();
        return true;
    } catch (error) {
        console.warn('[search] FTS migration unavailable; LIKE remains active:',
            error instanceof Error ? error.message : String(error));
        return false;
    }
}

const searchFtsReady = migrateSearchFts(db);

// Migration: add active_chat_session to session table
const sessionCols = db.prepare('PRAGMA table_info(session)').all();
if (!(sessionCols as Record<string, unknown>[]).some(c => c["name"] === 'active_chat_session')) {
    db.exec("ALTER TABLE session ADD COLUMN active_chat_session TEXT DEFAULT 'default'");
}

const chatSessionCols = db.prepare('PRAGMA table_info(chat_sessions)').all();
if (!(chatSessionCols as Record<string, unknown>[]).some(c => c["name"] === 'active_run_policy')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN active_run_policy TEXT DEFAULT NULL');
}
if (!(chatSessionCols as Record<string, unknown>[]).some(c => c["name"] === 'generation')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
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
export const insertMessageWithTraceRun = db.prepare('INSERT INTO messages (role, content, cli, model, trace, tool_log, working_dir, trace_run_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
export const getMessages = db.prepare('SELECT id, role, content, cli, model, tool_log, trace_run_id, cost_usd, duration_ms, working_dir, created_at FROM messages WHERE session_id = ? ORDER BY id ASC');
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

export const searchMessagesAllSessions = db.prepare(`
    SELECT id, role, content, cli, tool_log, created_at, session_id,
           CASE WHEN content LIKE '%' || $q || '%' THEN 'content' ELSE 'tool_log' END AS match_field
    FROM messages
    WHERE (content LIKE '%' || $q || '%' OR tool_log LIKE '%' || $q || '%')
      AND ($days IS NULL OR created_at >= datetime('now', '-' || $days || ' days'))
      AND ($recent IS NULL OR id >= COALESCE(
        (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET $recent),
        0
      ))
    ORDER BY id DESC
    LIMIT $limit
`);

export type ChatSearchCandidateEngine = 'unicode61' | 'trigram' | 'like';

export interface ChatSearchCandidateParams {
    match: string;
    like: string;
    session_id: string | null;
    days: number | null;
    recent: number | null;
    limit: number;
    offset: number;
}

export interface ChatSearchCandidateRow {
    id: number;
    role: string;
    content: string;
    cli: string | null;
    tool_log: string | null;
    session_id: string;
    created_at: string;
    match_field: 'content' | 'tool_log';
    source_score?: number | null;
}

const CHAT_SEARCH_SCOPE_SQL = `
    AND ($session_id IS NULL OR m.session_id = $session_id)
    AND ($days IS NULL OR m.created_at >= datetime('now', '-' || $days || ' days'))
    AND ($recent IS NULL OR m.id >= COALESCE(
        (SELECT id FROM messages
         WHERE ($session_id IS NULL OR session_id = $session_id)
         ORDER BY id DESC LIMIT 1 OFFSET $recent),
        0
    ))
`;

function prepareChatFtsStatement(sql: string): Database.Statement | null {
    if (!searchFtsReady) return null;
    try {
        return db.prepare(sql);
    } catch (error) {
        console.warn('[search] FTS statement unavailable; LIKE remains active:',
            error instanceof Error ? error.message : String(error));
        return null;
    }
}

const searchChatUnicode = prepareChatFtsStatement(`
    SELECT m.id, m.role, m.content, m.cli, m.tool_log, m.session_id, m.created_at,
           CASE WHEN m.content LIKE '%' || $like || '%' ESCAPE '\\'
                THEN 'content' ELSE 'tool_log' END AS match_field,
           bm25(messages_fts) AS source_score
    FROM messages_fts
    JOIN messages AS m ON m.id = messages_fts.rowid
    WHERE messages_fts MATCH $match
    ${CHAT_SEARCH_SCOPE_SQL}
    ORDER BY source_score ASC, m.id DESC
    LIMIT $limit OFFSET $offset
`);

const searchChatTrigram = prepareChatFtsStatement(`
    SELECT m.id, m.role, m.content, m.cli, m.tool_log, m.session_id, m.created_at,
           CASE WHEN m.content LIKE '%' || $like || '%' ESCAPE '\\'
                THEN 'content' ELSE 'tool_log' END AS match_field,
           bm25(messages_trigram) AS source_score
    FROM messages_trigram
    JOIN messages AS m ON m.id = messages_trigram.rowid
    WHERE messages_trigram MATCH $match
    ${CHAT_SEARCH_SCOPE_SQL}
    ORDER BY source_score ASC, m.id DESC
    LIMIT $limit OFFSET $offset
`);

const searchChatLike = db.prepare(`
    SELECT m.id, m.role, m.content, m.cli, m.tool_log, m.session_id, m.created_at,
           CASE WHEN m.content LIKE '%' || $like || '%' ESCAPE '\\'
                THEN 'content' ELSE 'tool_log' END AS match_field
    FROM messages AS m
    WHERE (m.content LIKE '%' || $like || '%' ESCAPE '\\'
       OR COALESCE(m.tool_log, '') LIKE '%' || $like || '%' ESCAPE '\\')
    ${CHAT_SEARCH_SCOPE_SQL}
    ORDER BY m.id DESC
    LIMIT $limit OFFSET $offset
`);

/** Execute one provider-only candidate statement; legacy search statements stay unchanged. */
export function searchChatCandidates(
    engine: ChatSearchCandidateEngine,
    params: ChatSearchCandidateParams,
): ChatSearchCandidateRow[] {
    if (engine === 'like') {
        return searchChatLike.all({
            like: params.like,
            session_id: params.session_id,
            days: params.days,
            recent: params.recent,
            limit: params.limit,
            offset: params.offset,
        }) as ChatSearchCandidateRow[];
    }
    const statement = engine === 'trigram' ? searchChatTrigram : searchChatUnicode;
    if (!statement) throw new Error('chat FTS index unavailable');
    return statement.all(params) as ChatSearchCandidateRow[];
}
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
export const getRecentMessagesAll = db.prepare('SELECT id, role, content, cli, model, tool_log, trace_run_id, cost_usd, duration_ms, working_dir, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');
export const getRecentMessagesAllWithTrace = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');
export const getMessageCount = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?');
export const getLatestAssistantMessage = db.prepare("SELECT id, role, content, created_at FROM messages WHERE role = 'assistant' AND session_id = ? ORDER BY id DESC LIMIT 1");
export const getLatestDashboardActivityMessage = db.prepare("SELECT id, role, substr(content, 1, 240) AS excerpt, created_at FROM messages WHERE role IN ('user', 'assistant') AND session_id = ? ORDER BY id DESC LIMIT 1");
const recentMessagesStmt = db.prepare('SELECT id, role, content, cli, model, trace, tool_log, created_at FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? ORDER BY id DESC LIMIT ?');
// Lightweight variant for per-turn callers that only read {role, content}.
// Avoids loading the heavy trace/tool_log blobs that getRecentMessages carries.
const recentMessagesLiteStmt = db.prepare('SELECT role, content FROM messages WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? ORDER BY id DESC LIMIT ?');

/**
 * These two are the history-replay readers: their rows are fed back to a model
 * as prior turns (prompt history, resume fallback, AGY replay, memory flush,
 * compaction, the P-phase plan). The stored text may end with the notice a
 * watchdog-killed turn shows its READER, and that sentence reads as an
 * instruction when it comes back as context — so it comes off here, once,
 * rather than at each call site that would have to remember (#405).
 *
 * `/api/messages` deliberately does NOT go through this: the transcript is for
 * a person, and leaving the notice out there is what made it vanish on refresh.
 */
function stripNoticeFromRows<T>(rows: T[]): T[] {
    for (const row of rows) {
        const record = row as { content?: unknown };
        if (typeof record.content === 'string') {
            record.content = stripStallTruncationNotice(record.content);
        }
    }
    return rows;
}

export const getRecentMessages = {
    all: (...args: unknown[]) => stripNoticeFromRows(recentMessagesStmt.all(...args as [])),
};

// Ascending and watermark-bounded, for the merged memory flush.
//
// recentMessagesStmt cannot serve it: DESC + LIMIT keeps the NEWEST n rows, which is
// right for a prompt window and wrong for a summariser. If a session ever falls more
// than n rows behind, the newest-n view silently drops the front of that backlog and
// the watermark then commits past the rows nobody read.
const unflushedMessagesStmt = db.prepare(
    'SELECT id, role, content FROM messages'
    + ' WHERE (working_dir = ? OR working_dir IS NULL) AND session_id = ? AND id > ?'
    + ' ORDER BY id ASC LIMIT ?',
);
export const getUnflushedMessages = {
    all: (...args: unknown[]) => stripNoticeFromRows(unflushedMessagesStmt.all(...args as [])),
};

// Sessions that actually hold rows in scope. Enumerating chat_sessions instead would
// miss rows whose session row was deleted — messages has no foreign key to it.
export const getSessionIdsWithMessages = db.prepare(
    'SELECT DISTINCT session_id FROM messages WHERE (working_dir = ? OR working_dir IS NULL)',
);
export const getRecentMessagesLite = {
    all: (...args: unknown[]) => stripNoticeFromRows(recentMessagesLiteStmt.all(...args as [])),
};
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
export const copySessionBucketIfMissing = db.prepare(`
    INSERT OR IGNORE INTO session_buckets (
        bucket, session_id, model, resume_key, output_len, memory_snapshot,
        updated_at, last_run_clean, last_run_cwd, last_run_meta
    )
    SELECT ?, session_id, model, resume_key, output_len, memory_snapshot,
        updated_at, last_run_clean, last_run_cwd, last_run_meta
    FROM session_buckets WHERE bucket = ?
`);
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
const clearSessionBucketsByPrefixStmt = db.prepare(
    "DELETE FROM session_buckets WHERE bucket = ? OR bucket LIKE ? ESCAPE '\\'",
);

// A scope name reaches this statement verbatim, and a remote binding key is
// percent-encoded (`jaw:slack:T1:C%20name`), so it can carry the very characters LIKE
// treats as wildcards. Unescaped, the prefix for one Slack scope would match — and
// delete — every other scope's bucket. The statement already declared an escape
// character; nothing was using it.
export function escapeLikePattern(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Deletes one bucket and everything beneath it. The caller passes the literal prefix,
 * not a LIKE pattern, so the wildcard is appended here — otherwise every caller would
 * have to remember to escape the prefix but not the trailing `%`, and one of them
 * eventually would not.
 */
export const clearSessionBucketsByPrefix = {
    run: (bucket: string, descendantsOf: string) =>
        clearSessionBucketsByPrefixStmt.run(bucket, `${escapeLikePattern(descendantsOf)}%`),
};
export const updateSessionBucketLastRun = db.prepare('UPDATE session_buckets SET last_run_clean=?, last_run_cwd=?, last_run_meta=? WHERE bucket=?');

// ─── Message Queue Persistence ──────────────────────
export const listQueuedMessages = db.prepare('SELECT id, payload FROM queued_messages ORDER BY created_at ASC');
export const insertQueuedMessage = db.prepare('INSERT OR REPLACE INTO queued_messages (id, payload) VALUES (?, ?)');
export const deleteQueuedMessage = db.prepare('DELETE FROM queued_messages WHERE id = ?');
export const clearQueuedMessages = db.prepare('DELETE FROM queued_messages');

// ─── Slack Event Dedupe Persistence (#321) ──────────
export const findSlackEventDedup = db.prepare('SELECT expires_at FROM slack_event_dedup WHERE event_key = ?');
export const insertSlackEventDedup = db.prepare('INSERT OR REPLACE INTO slack_event_dedup (event_key, expires_at) VALUES (?, ?)');
export const sweepSlackEventDedup = db.prepare('DELETE FROM slack_event_dedup WHERE expires_at <= ?');
export const clearSlackEventDedup = db.prepare('DELETE FROM slack_event_dedup');

type QueuedMessageMigrationPayload = Record<string, unknown> & {
    schemaVersion?: number;
    chatSessionId?: string;
};
const rewriteQueuedMessage = db.prepare('UPDATE queued_messages SET payload = ? WHERE id = ?');
const queuedSessionExists = db.prepare('SELECT 1 FROM chat_sessions WHERE id = ?');

export const migrateQueuedMessagesV1ToV2 = db.transaction((): void => {
    const droppedIds: string[] = [];
    const rows = listQueuedMessages.all() as Array<{ id: string; payload: string }>;
    for (const row of rows) {
        let payload: QueuedMessageMigrationPayload;
        try {
            const parsed = JSON.parse(row.payload) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            payload = parsed as QueuedMessageMigrationPayload;
        } catch {
            continue;
        }
        if (payload.schemaVersion === undefined) {
            payload = { ...payload, schemaVersion: 2, scope: 'default', chatSessionId: 'default' };
            rewriteQueuedMessage.run(JSON.stringify(payload), row.id);
        }
        const sessionId = typeof payload.chatSessionId === 'string' ? payload.chatSessionId : 'default';
        if (!queuedSessionExists.get(sessionId)) {
            deleteQueuedMessage.run(row.id);
            droppedIds.push(row.id);
        }
    }
    if (droppedIds.length > 0) {
        console.warn(`[queue:migrate:v2] dropped deleted-session rows: ${droppedIds.join(', ')}`);
    }
});

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

/** Unconditional reset, for when the caller knows the in-memory runtime is gone.
 *
 *  The stale variant above deliberately spares recent rows so a restart can
 *  resume a live cycle. That guess is wrong after a crash: the workers a phase
 *  was waiting on live in memory and did not survive, so the row describes a
 *  handoff that can never complete and only a human can say so (#452). */
export const resetEveryOrcState = db.prepare(
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

initSessionGeneration(db);

export { db };
