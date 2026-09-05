import type Database from 'better-sqlite3';
import { MAX_TOOL_LOG_JSON_CHARS, sanitizeSerializedToolLog } from '../shared/tool-log-sanitize.js';
const TOOL_LOG_MIGRATION = 'messages-tool-log-sanitize-v1';
const TOOL_LOG_BATCH_SIZE = 25;
export interface DatabaseStorageStats { pageCount: number; freelistCount: number; freeRatio: number }
export function migrateOversizedToolLogs(database: Database.Database): number {
    database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const applied = database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
    if (applied.get(TOOL_LOG_MIGRATION)) return 0;
    const selectBatch = database.prepare('SELECT id, tool_log FROM messages WHERE tool_log IS NOT NULL AND length(tool_log) > ? ORDER BY id ASC LIMIT ?');
    const update = database.prepare('UPDATE messages SET tool_log = ? WHERE id = ?');
    const rewriteBatch = database.transaction((rows: Array<{ id: number; tool_log: string }>) => {
        for (const row of rows) update.run(sanitizeSerializedToolLog(row.tool_log), row.id);
    });
    let rewritten = 0;
    while (true) {
        const rows = selectBatch.all(MAX_TOOL_LOG_JSON_CHARS, TOOL_LOG_BATCH_SIZE) as Array<{ id: number; tool_log: string }>;
        if (rows.length === 0) break;
        rewriteBatch(rows);
        rewritten += rows.length;
    }
    database.prepare('INSERT OR IGNORE INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(TOOL_LOG_MIGRATION, Date.now());
    return rewritten;
}
export function readDatabaseStorageStats(database: Database.Database): DatabaseStorageStats {
    const pageCount = Number(database.pragma('page_count', { simple: true }));
    const freelistCount = Number(database.pragma('freelist_count', { simple: true }));
    return { pageCount, freelistCount, freeRatio: pageCount > 0 ? freelistCount / pageCount : 0 };
}
export class DatabaseBusyError extends Error {
    constructor(message: string) { super(message); this.name = 'DatabaseBusyError'; }
}

/** Checkpoint the WAL and VACUUM. Throws DatabaseBusyError instead of reporting
 *  a half-done checkpoint as success: wal_checkpoint(TRUNCATE) returns busy=1
 *  when a reader still pins the WAL snapshot (typically a running server), and
 *  the WAL then stays on disk however the VACUUM went. */
export function maintainDatabase(database: Database.Database): { before: DatabaseStorageStats; after: DatabaseStorageStats } {
    const before = readDatabaseStorageStats(database);
    const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
    const result = checkpoint[0];
    if (!result || result.busy !== 0 || result.log !== result.checkpointed) {
        throw new DatabaseBusyError(
            `WAL checkpoint could not complete (busy=${result?.busy ?? '?'}, log=${result?.log ?? '?'}, checkpointed=${result?.checkpointed ?? '?'}) — another connection is reading the database; stop the server (jaw service stop) or retry when idle`,
        );
    }
    database.exec('VACUUM');
    return { before, after: readDatabaseStorageStats(database) };
}
