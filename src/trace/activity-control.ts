import { db } from '../core/db.js';

export const ACTIVITY_CONTROL_TYPE = 'runtime.control.v1';
export type ActivityLoss = 'event_limit' | 'run_limit' | 'global_limit' | 'storage_error' | 'retention';
export type ActivityControl = {
    version: 1; count: number; bytes: number; lastSeq: number; closed: boolean; loss: ActivityLoss | null;
};
const CONTROL_BYTES = 2048;
const losses = new Set<ActivityLoss>(['event_limit', 'run_limit', 'global_limit', 'storage_error', 'retention']);
const read = db.prepare(`SELECT seq,
    CASE WHEN length(CAST(raw_json AS BLOB)) <= ${CONTROL_BYTES} THEN raw_json ELSE NULL END AS raw_json
    FROM trace_events WHERE run_id = ? AND source = 'system' AND event_type = 'runtime.control.v1'`);
const write = db.prepare(`UPDATE trace_events SET raw_json = ?, bytes = ?, preview = 'runtime control'
    WHERE run_id = ? AND seq = ? AND source = 'system' AND event_type = 'runtime.control.v1'`);

export function readActivityControl(runId: string): { seq: number; state: ActivityControl } | null {
    const row = read.get(runId) as { seq: number; raw_json: string | null } | undefined;
    if (!row) return null;
    if (row.raw_json === null) throw new Error('activity_control_corrupt');
    let value: unknown;
    try { value = JSON.parse(row.raw_json); }
    catch { throw new Error('activity_control_corrupt'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('activity_control_corrupt');
    const c = value as Record<string, unknown>;
    if (Object.keys(c).some(k => !['version', 'count', 'bytes', 'lastSeq', 'closed', 'loss'].includes(k))
        || c['version'] !== 1 || typeof c['closed'] !== 'boolean'
        || !['count', 'bytes', 'lastSeq'].every(k => Number.isSafeInteger(c[k]) && Number(c[k]) >= 0)
        || (c['loss'] !== null && !losses.has(c['loss'] as ActivityLoss))) throw new Error('activity_control_corrupt');
    return { seq: row.seq, state: { version: 1, count: Number(c['count']), bytes: Number(c['bytes']),
        lastSeq: Number(c['lastSeq']), closed: c['closed'], loss: c['loss'] as ActivityLoss | null } };
}

export function writeActivityControl(runId: string, seq: number, state: ActivityControl): void {
    const raw = JSON.stringify(state);
    if (write.run(raw, Buffer.byteLength(raw), runId, seq).changes !== 1) throw new Error('activity_control_missing');
}

/** Best-effort metadata must never obstruct final delivery or interrupted MESSAGE salvage. */
export function markActivityLoss(runId: string, loss: ActivityLoss): void {
    try {
        db.transaction(() => {
            const current = readActivityControl(runId);
            if (current && !current.state.loss) writeActivityControl(runId, current.seq, { ...current.state, loss });
        }).immediate();
    } catch { console.warn('[activity] loss_metadata_unavailable'); }
}

export function closeActivity(runId: string, loss?: ActivityLoss): void {
    try {
        db.transaction(() => {
            const current = readActivityControl(runId);
            if (!current) return;
            writeActivityControl(runId, current.seq, { ...current.state, closed: true,
                loss: current.state.loss ?? loss ?? (current.state.closed ? null : 'storage_error') });
        }).immediate();
    } catch { console.warn('[activity] close_metadata_unavailable'); }
}

/** Delete a whole append-dependent prefix; preserve its cursor and explicit loss. */
export function expireActivityPrefix(runId: string): number {
    return db.transaction(() => {
        let current: ReturnType<typeof readActivityControl> = null;
        try { current = readActivityControl(runId); }
        catch (error) {
            if (!(error instanceof Error) || error.message !== 'activity_control_corrupt') throw error;
            // Keep the corrupt control as a fail-closed tombstone for active owners;
            // reclaim its entire runtime prefix without blocking unrelated retention.
            console.warn('[activity] expired_corrupt_control');
        }
        if (current) writeActivityControl(runId, current.seq, {
            ...current.state, count: 0, bytes: 0, closed: true, loss: 'retention',
        });
        return db.prepare("DELETE FROM trace_events WHERE run_id = ? AND source = 'runtime'").run(runId).changes;
    }).immediate();
}
