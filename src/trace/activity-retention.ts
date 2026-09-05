import { db } from '../core/db.js';
import { expireActivityPrefix } from './activity-control.js';

const rawPredicate = "source <> 'runtime' AND NOT (source = 'system' AND event_type = 'runtime.control.v1')";
const countRows = db.prepare('SELECT COUNT(*) AS count FROM trace_events');

/** Retention never removes an append base from a retained semantic suffix. */
export function pruneActivityTraceRows(cutoff: number, maxRows: number): { deletedEvents: number; deletedRuns: number } {
    return db.transaction(() => {
        const before = (countRows.get() as { count: number }).count;
        for (const run of db.prepare(`SELECT DISTINCT run_id FROM trace_events
            WHERE source = 'runtime' AND created_at < ?`).all(cutoff) as { run_id: string }[]) {
            expireActivityPrefix(run.run_id);
        }
        // A producer may still own an expired, closed projection. Only the trace
        // lifecycle status, not control.closed, makes its owner safe to remove.
        let deletedRuns = db.prepare(`DELETE FROM trace_runs WHERE started_at < ? AND
            (status <> 'running' OR (session_id IS NULL AND scope_key IS NULL AND NOT EXISTS (SELECT 1 FROM trace_events e
                WHERE e.run_id = trace_runs.id AND e.source = 'system' AND e.event_type = 'runtime.control.v1')))`)
            .run(cutoff).changes;
        db.prepare(`DELETE FROM trace_events WHERE created_at < ? AND ${rawPredicate}`).run(cutoff);
        const cap = Math.max(0, Math.floor(maxRows));
        let total = (countRows.get() as { count: number }).count;
        if (total > cap) {
            db.prepare(`DELETE FROM trace_events WHERE rowid IN
                (SELECT rowid FROM trace_events WHERE ${rawPredicate} ORDER BY created_at, rowid LIMIT ?)`)
                .run(total - cap);
        }
        total = (countRows.get() as { count: number }).count;
        if (total > cap) {
            const closed = db.prepare(`SELECT r.id FROM trace_runs r WHERE r.status <> 'running'
                AND EXISTS (SELECT 1 FROM trace_events e WHERE e.run_id = r.id AND e.source = 'runtime')
                ORDER BY r.started_at, r.id`).all() as { id: string }[];
            for (const run of closed) {
                if (total <= cap) break;
                total -= expireActivityPrefix(run.id);
            }
        }
        // Tombstones themselves have a finite lifetime under a configured row cap.
        // If necessary remove oldest closed owners, preserving active owners even
        // when their control has already been closed by expiry.
        if (total > cap) {
            const closed = db.prepare(`SELECT r.id, COUNT(e.seq) AS count FROM trace_runs r
                JOIN trace_events e ON e.run_id = r.id WHERE r.status <> 'running'
                GROUP BY r.id ORDER BY r.started_at, r.id`).all() as { id: string; count: number }[];
            for (const run of closed) {
                if (total <= cap) break;
                deletedRuns += db.prepare('DELETE FROM trace_runs WHERE id = ?').run(run.id).changes;
                total -= run.count;
            }
        }
        return { deletedEvents: before - (countRows.get() as { count: number }).count, deletedRuns };
    }).immediate();
}
