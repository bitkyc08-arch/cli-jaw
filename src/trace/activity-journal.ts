import { db } from '../core/db.js';
import { settings } from '../core/config.js';
import type { RuntimeEvent } from '../shared/runtime-contract.js';
import type { TracePointer, TraceRunStatus } from './types.js';
import { appendTraceEvent } from './store.js';
import { stringifyTraceValue } from './redact.js';
import { decodeRuntimeBody, RUNTIME_BODY_BYTES, type RuntimeBodyRecord } from './runtime-body-codec.js';
import { ACTIVITY_CONTROL_TYPE, readActivityControl, writeActivityControl, markActivityLoss,
    type ActivityControl, type ActivityLoss } from './activity-control.js';
export { closeActivity, type ActivityLoss } from './activity-control.js';

export const ACTIVITY_RUN_ROWS = 4096;
export const ACTIVITY_RUN_BYTES = 4 * 1024 * 1024;
export const ACTIVITY_GLOBAL_ROWS = 20_000;
export const ACTIVITY_GLOBAL_BYTES = 32 * 1024 * 1024;
export const ACTIVITY_PAGE_ROWS = 40;
export const ACTIVITY_PAGE_BYTES = 256 * 1024;

type OwnerRow = { id: string; session_id: string; scope_key: string | null;
    status: TraceRunStatus; audience: 'public' | 'internal' };
export type ActivityOwner = OwnerRow & { scope_key: string };
const ownerStmt = db.prepare(`SELECT r.id, r.session_id, r.scope_key, r.status, r.audience
    FROM trace_runs r JOIN chat_sessions s ON s.id = r.session_id WHERE r.id = ? AND r.session_id = ?`);
const totals = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM trace_events WHERE source = 'runtime'");
const rowCount = db.prepare('SELECT COUNT(*) AS count FROM trace_events');
const rowsStmt = db.prepare(`SELECT seq, event_type, bytes,
    CASE WHEN length(CAST(raw_json AS BLOB)) <= ${RUNTIME_BODY_BYTES} THEN raw_json ELSE NULL END AS raw_json
    FROM trace_events WHERE run_id = ? AND source = 'runtime' AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`);
const terminalStmt = db.prepare(`SELECT 1 FROM trace_events WHERE run_id = ? AND seq = ?
    AND source = 'runtime' AND event_type = 'turn-end'`);
const runsStmt = db.prepare(`SELECT r.id, r.message_id, r.status, r.started_at
    FROM trace_runs r JOIN chat_sessions s ON s.id = r.session_id
    WHERE r.session_id = ? AND r.audience = 'public' AND length(r.scope_key) BETWEEN 1 AND 240
    AND (? = '' OR r.id > ?) ORDER BY r.id LIMIT ${ACTIVITY_PAGE_ROWS}`);

export function isTraceSessionOwner(runId: string, sessionId: string): boolean {
    const row = ownerStmt.get(runId, sessionId) as OwnerRow | undefined;
    return row?.audience === 'public';
}

export function getActivityOwner(runId: string, sessionId: string): ActivityOwner | null {
    const row = ownerStmt.get(runId, sessionId) as OwnerRow | undefined;
    return row?.audience === 'public' && row.scope_key && row.scope_key.length <= 240
        ? { ...row, scope_key: row.scope_key } : null;
}

export type ActivityRunSummary = { id: string; messageId: number | null; status: TraceRunStatus; startedAt: number };
export function listActivityRuns(sessionId: string, after = ''): ActivityRunSummary[] {
    const rows = runsStmt.all(sessionId, after, after) as {
        id: string; message_id: number | null; status: TraceRunStatus; started_at: number;
    }[];
    return rows.map(r => ({ id: r.id, messageId: r.message_id, status: r.status, startedAt: r.started_at }));
}

type AppendInput = { runId: string; sessionId: string; scope: string; audience: 'public' | 'internal';
    eventType: string; raw: RuntimeBodyRecord };
type AppendOwner = Pick<AppendInput, 'runId' | 'sessionId' | 'scope' | 'audience'>;

/** Preflight failures must not retire another owner or an already-completed run. */
export function markActivityFailure(input: AppendOwner, loss: ActivityLoss): void {
    try {
        db.transaction(() => {
            const owner = ownerStmt.get(input.runId, input.sessionId) as OwnerRow | undefined;
            if (!owner || owner.scope_key !== input.scope || owner.audience !== input.audience || owner.status !== 'running') return;
            const current = readActivityControl(input.runId);
            if (current && !current.state.closed) markActivityLoss(input.runId, loss);
        }).immediate();
    } catch { console.warn('[activity] failure_metadata_unavailable'); }
}
const append = db.transaction((input: AppendInput): TracePointer | null => {
    const owner = ownerStmt.get(input.runId, input.sessionId) as OwnerRow | undefined;
    if (!owner || owner.scope_key !== input.scope || owner.audience !== input.audience || owner.status !== 'running') return null;
    let current = readActivityControl(input.runId);
    if (!current) {
        if (input.eventType !== 'turn-start') return null;
        const state: ActivityControl = { version: 1, count: 0, bytes: 0, lastSeq: 0, closed: false, loss: null };
        const pointer = appendTraceEvent({ runId: input.runId, source: 'system', eventType: ACTIVITY_CONTROL_TYPE,
            raw: state, preview: 'runtime control' });
        if (!pointer) throw new Error('activity_control_write_failed');
        current = { seq: pointer.traceSeq, state };
    }
    const c = current.state;
    if (c.closed || c.loss) return null;
    const bytes = Buffer.byteLength(stringifyTraceValue(input.raw));
    const total = totals.get() as { count: number; bytes: number };
    const allRows = (rowCount.get() as { count: number }).count;
    const configuredRows = settings['trace']?.maxRows ?? 50_000;
    const loss: ActivityLoss | null = bytes > RUNTIME_BODY_BYTES ? 'event_limit'
        : c.count >= ACTIVITY_RUN_ROWS || c.bytes + bytes > ACTIVITY_RUN_BYTES ? 'run_limit'
            : total.count >= ACTIVITY_GLOBAL_ROWS || total.bytes + bytes > ACTIVITY_GLOBAL_BYTES
                || allRows >= configuredRows ? 'global_limit' : null;
    if (loss) { writeActivityControl(input.runId, current.seq, { ...c, loss }); return null; }
    const pointer = appendTraceEvent({ runId: input.runId, source: 'runtime', eventType: input.eventType,
        raw: input.raw, preview: input.eventType });
    if (!pointer) throw new Error('activity_write_failed');
    writeActivityControl(input.runId, current.seq, { ...c, count: c.count + 1, bytes: c.bytes + bytes,
        lastSeq: pointer.traceSeq, closed: input.eventType === 'turn-end' });
    return pointer;
});

export function appendActivityBody(input: AppendInput): TracePointer | null {
    try { return append.immediate(input); }
    catch {
        markActivityFailure(input, 'storage_error');
        console.warn('[activity] append_failed');
        return null;
    }
}

export type ActivityPage = { runId: string; sessionId: string; scope: string; status: TraceRunStatus;
    events: RuntimeEvent[]; nextAfter: number; through: number; hasMore: boolean; incomplete: boolean; loss: string | null };
type PageInput = { runId: string; sessionId: string; after: number; through?: number; limit: number };
const readPage = db.transaction((input: PageInput): ActivityPage | null => {
    const owner = getActivityOwner(input.runId, input.sessionId);
    if (!owner) return null;
    const control = readActivityControl(input.runId);
    const high = input.through ?? control?.state.lastSeq ?? 0;
    if (high > (control?.state.lastSeq ?? 0) || input.after > high) throw new RangeError('activity_cursor');
    const limit = Math.max(1, Math.min(ACTIVITY_PAGE_ROWS, input.limit));
    const rows = rowsStmt.all(input.runId, input.after, high, limit + 1) as {
        seq: number; event_type: string; raw_json: string | null; bytes: number;
    }[];
    const page: ActivityPage = { runId: owner.id, sessionId: owner.session_id, scope: owner.scope_key,
        status: owner.status, events: [], nextAfter: input.after, through: high, hasMore: false,
        incomplete: false, loss: control?.state.loss ?? (control ? null : 'unavailable') };
    // Include identity/envelope overhead; loss/boolean changes fit the reserved bytes.
    let used = Buffer.byteLength(JSON.stringify(page)) + 128;
    let consumed = 0;
    for (const row of rows) {
        if (consumed >= limit) break;
        let event: RuntimeEvent | null = null;
        if (row.raw_json !== null && row.bytes >= 0 && row.bytes <= RUNTIME_BODY_BYTES) {
            try { event = decodeRuntimeBody(JSON.parse(row.raw_json), {
                version: 1, runId: owner.id, sessionId: owner.session_id, scope: owner.scope_key, seq: row.seq,
            }, row.event_type); } catch { /* Corrupt storage advances the scan cursor below. */ }
        }
        if (!event) { consumed++; page.nextAfter = row.seq; page.loss = 'corrupt'; continue; }
        const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (used + bytes > ACTIVITY_PAGE_BYTES) break;
        used += bytes;
        page.events.push(event);
        page.nextAfter = row.seq;
        consumed++;
    }
    page.hasMore = consumed < rows.length;
    if (!page.hasMore) page.nextAfter = high;
    const missingTerminal = owner.status !== 'running'
        && (!control || !terminalStmt.get(owner.id, control.state.lastSeq));
    page.incomplete = page.loss !== null || missingTerminal;
    return page;
});

export function readActivityPage(input: PageInput): ActivityPage | null { return readPage(input); }
