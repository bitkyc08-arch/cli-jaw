import crypto from 'node:crypto';
import fs from 'fs';
import { join, relative, resolve } from 'path';
import { JAW_HOME } from '../core/config.js';
import { db } from '../core/db.js';
import type { ToolEntry } from '../types/agent.js';
import { stringifyTraceValue, tracePreview } from './redact.js';
import { closeActivity } from './activity-control.js';
import { pruneActivityTraceRows } from './activity-retention.js';
import type { TraceAudience, TraceCarrier, TraceEventInput, TracePointer, TraceRetentionStatus, TraceRunInput, TraceRunStatus } from './types.js';

const TRACE_INLINE_MAX_BYTES = 96_000;
const TRACE_PREVIEW_CHARS = 360;
const TRACE_DIR = join(JAW_HOME, 'traces');
const TRACE_ID_RE = /^tr_[A-Za-z0-9_-]{16,80}$/;

type TraceRunRow = {
    id: string; message_id?: number | null; cli?: string | null; model?: string | null;
    working_dir?: string | null; agent_label?: string | null; audience?: TraceAudience;
    status?: TraceRunStatus; raw_retention_status?: TraceRetentionStatus; event_count?: number;
    byte_count?: number; started_at?: number; finished_at?: number | null; error?: string | null;
    session_id: string | null; scope_key: string | null;
};
type TraceEventRow = {
    run_id: string; seq: number; source: string; event_type: string; preview?: string | null;
    raw_json?: string | null; raw_path?: string | null; bytes?: number;
    retention_status?: TraceRetentionStatus; created_at?: number;
};

const insertRun = db.prepare(`
    INSERT INTO trace_runs
    (id, parent_run_id, cli, model, working_dir, agent_label, audience, started_at, last_event_at, session_id, scope_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertEvent = db.prepare(`
    INSERT INTO trace_events
    (run_id, seq, source, event_type, preview, raw_json, raw_path, bytes, retention_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateRunEventStats = db.prepare(`
    UPDATE trace_runs
    SET event_count = event_count + 1,
        byte_count = byte_count + ?,
        raw_retention_status = CASE WHEN raw_retention_status = 'spilled' OR ? = 'spilled' THEN 'spilled' ELSE raw_retention_status END,
        last_event_at = ?
    WHERE id = ?
`);
const finalizeRunStmt = db.prepare('UPDATE trace_runs SET status = ?, finished_at = ?, error = COALESCE(?, error) WHERE id = ?');
const linkRunStmt = db.prepare('UPDATE trace_runs SET message_id = ? WHERE id = ?');
const getRunStmt = db.prepare('SELECT * FROM trace_runs WHERE id = ?');
const listEventsStmt = db.prepare(`
    SELECT run_id, seq, source, event_type, preview, bytes, retention_status, created_at
    FROM trace_events WHERE run_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?
`);
const countEventsStmt = db.prepare('SELECT COUNT(*) AS count FROM trace_events WHERE run_id = ?');
const getEventStmt = db.prepare('SELECT * FROM trace_events WHERE run_id = ? AND seq = ?');
const maxSeqStmt = db.prepare('SELECT MAX(seq) AS seq FROM trace_events WHERE run_id = ?');
// Option D hydration (devlog 260620 Phase 3): a finished message's tool cards rebuilt
// from the durable, uncapped trace_events instead of the lossy messages.tool_log blob.
const listRunsForMessageStmt = db.prepare(
    'SELECT id, audience, started_at FROM trace_runs WHERE message_id = ? ORDER BY started_at ASC, id ASC');
const listToolEventsForRunStmt = db.prepare(`
    SELECT seq, event_type, raw_json, raw_path, bytes, retention_status
    FROM trace_events WHERE run_id = ? AND source = 'tool' ORDER BY seq ASC LIMIT ?
`);
// WP4 (devlog 260703 doc 12): live-run hydration reads the NEWEST tool rows and the
// snapshot gate counts them; update-in-place converges a row to the tool's final state.
const listToolEventsDescStmt = db.prepare(`
    SELECT seq, raw_json, raw_path, bytes, retention_status
    FROM trace_events WHERE run_id = ? AND source = 'tool' ORDER BY seq DESC LIMIT ?
`);
const countToolEventsStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM trace_events WHERE run_id = ? AND source = 'tool'");
const updateEventStmt = db.prepare(`
    UPDATE trace_events SET preview = ?, raw_json = ?, raw_path = ?, bytes = ?, retention_status = ?
    WHERE run_id = ? AND seq = ? AND source = 'tool'
`);
const interruptStaleStmt = db.prepare(`
    UPDATE trace_runs SET status = 'interrupted', finished_at = ?, error = COALESCE(error, 'process exited before finalization')
    WHERE status = 'running'
`);
const liveRunIdsStmt = db.prepare('SELECT id FROM trace_runs');
const seqCache = new Map<string, number>();

export function createTraceId(): string { return `tr_${crypto.randomUUID().replace(/-/g, '')}`; }
function ensureTraceDir(runId: string): string {
    const dir = join(TRACE_DIR, runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function nextSeq(runId: string): number {
    const cached = seqCache.get(runId);
    if (cached != null) { const next = cached + 1; seqCache.set(runId, next); return next; }
    const row = maxSeqStmt.get(runId) as { seq?: number | null } | undefined;
    const next = Number(row?.seq || 0) + 1;
    seqCache.set(runId, next);
    return next;
}
function safeRawPath(rawPath: string): string | null {
    const base = resolve(TRACE_DIR);
    const absolute = resolve(JAW_HOME, rawPath);
    if (!absolute.startsWith(base + '/') && absolute !== base) return null;
    return absolute;
}
function persistPayload(runId: string, seq: number, payload: string): {
    rawJson: string | null; rawPath: string | null; status: TraceRetentionStatus;
} {
    if (Buffer.byteLength(payload, 'utf8') <= TRACE_INLINE_MAX_BYTES) return { rawJson: payload, rawPath: null, status: 'available' };
    const file = join(ensureTraceDir(runId), `${String(seq).padStart(6, '0')}.json`);
    fs.writeFileSync(file, payload);
    return { rawJson: null, rawPath: relative(JAW_HOME, file), status: 'spilled' };
}

export function startTraceRun(input: TraceRunInput): string {
    const id = createTraceId();
    const now = Date.now();
    insertRun.run(id, input.parentRunId || null, input.cli || 'agent', input.model || null,
        input.workingDir || null, input.agentLabel || null, input.audience || 'public', now, now,
        input.sessionId ?? null, input.scopeKey ?? null);
    return id;
}

export function appendTraceEvent(input: TraceEventInput): TracePointer | null {
    const runId = input.runId || '';
    if (!TRACE_ID_RE.test(runId)) return null;
    try {
        const seq = nextSeq(runId);
        const payload = stringifyTraceValue(input.raw);
        const bytes = Buffer.byteLength(payload, 'utf8');
        const stored = persistPayload(runId, seq, payload);
        const preview = input.preview || tracePreview(input.raw, input.eventType, TRACE_PREVIEW_CHARS);
        const now = Date.now();
        insertEvent.run(runId, seq, input.source, input.eventType || 'event', preview, stored.rawJson, stored.rawPath, bytes, stored.status, now);
        updateRunEventStats.run(bytes, stored.status, now, runId);
        return { traceRunId: runId, traceSeq: seq, detailAvailable: true, detailBytes: bytes, rawRetentionStatus: stored.status };
    } catch (error) {
        console.error('[trace] append failed:', error instanceof Error ? error.message : String(error));
        return null;
    }
}

export function stampTraceTool(tool: ToolEntry, ctx: TraceCarrier, eventType = 'tool'): ToolEntry {
    if (!ctx.traceRunId || tool.traceRunId) return tool;
    const pointer = appendTraceEvent({ runId: ctx.traceRunId, source: 'tool', eventType, raw: tool, preview: `${tool.toolType || 'tool'}: ${tool.label || 'tool'}` });
    if (!pointer) return tool;
    const exposed = ctx.traceAudience !== 'internal';
    Object.assign(tool, {
        traceRunId: pointer.traceRunId, traceSeq: pointer.traceSeq,
        detailAvailable: exposed && pointer.detailAvailable, detailBytes: pointer.detailBytes,
        rawRetentionStatus: exposed ? pointer.rawRetentionStatus : 'internal',
    });
    // Completion handlers resolve tools by stepRef in ctx.toolLog; once the RAM cap
    // evicts the entry that lookup misses forever. The per-run index lets them still
    // converge the durable row (WP4 item 3).
    if (tool.stepRef) {
        const carrier = ctx as TraceCarrier & { toolTraceIndex?: Map<string, TracePointer> };
        if (!carrier.toolTraceIndex) carrier.toolTraceIndex = new Map();
        carrier.toolTraceIndex.set(tool.stepRef, pointer);
    }
    return tool;
}

/** Re-persist a mutated ToolEntry over its existing `source='tool'` row so the durable
 *  card converges to final status/detail. Tool rows are card projections (they already
 *  round-trip via traceToolEventToEntry), not an append-only event log — in-place
 *  convergence keeps every hydration consumer fold-free. trace_runs.byte_count stays
 *  approximate on updates by design. */
export function updateTraceToolRow(tool: ToolEntry): void {
    const runId = tool.traceRunId || '';
    const seq = Number(tool.traceSeq);
    if (!TRACE_ID_RE.test(runId) || !Number.isInteger(seq) || seq < 1) return;
    try {
        const prior = getEventStmt.get(runId, seq) as TraceEventRow | undefined;
        if (!prior || prior.source !== 'tool') return;
        const payload = stringifyTraceValue(tool);
        const bytes = Buffer.byteLength(payload, 'utf8');
        const stored = persistPayload(runId, seq, payload);
        const preview = `${tool.toolType || 'tool'}: ${tool.label || 'tool'}`;
        updateEventStmt.run(preview, stored.rawJson, stored.rawPath, bytes, stored.status, runId, seq);
        // Spill hygiene: pruneOrphanTraceDirs only sweeps whole-run dirs, so a row
        // whose payload moved back inline must unlink its stale per-row spill file.
        if (prior.raw_path && prior.raw_path !== stored.rawPath) {
            const stale = safeRawPath(prior.raw_path);
            if (stale && fs.existsSync(stale)) fs.rmSync(stale, { force: true });
        }
    } catch (error) {
        console.error('[trace] tool row update failed:', error instanceof Error ? error.message : String(error));
    }
}

/** Count of durable tool rows for a run — the cheap "is RAM behind?" gate for
 *  live-run snapshot hydration (satisfied by the (run_id, seq) index). */
export function countToolTraceRows(runId: string): number {
    if (!TRACE_ID_RE.test(runId)) return 0;
    const row = countToolEventsStmt.get(runId) as { c?: number } | undefined;
    return Number(row?.c || 0);
}

/** Rebuild the newest tool cards of a LIVE run from trace_events. Bounded newest-N
 *  read (live DB showed runs with 7k+ tool rows / 18MB — never read a whole run per
 *  snapshot request). Row pointers are synthesized from row metadata: tool payloads
 *  were stamped before pointer assignment, so raw JSON lacks them. */
export function listToolEntriesForRun(runId: string, limit = 400): ToolEntry[] {
    if (!TRACE_ID_RE.test(runId)) return [];
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = listToolEventsDescStmt.all(runId, safeLimit) as {
        seq: number; raw_json: string | null; raw_path: string | null;
        bytes?: number; retention_status?: TraceRetentionStatus;
    }[];
    const out: ToolEntry[] = [];
    for (const ev of rows.reverse()) {
        const tool = traceToolEventToEntry(ev);
        if (!tool) continue;
        const hydrated: ToolEntry = { ...tool, traceRunId: runId, traceSeq: ev.seq, detailAvailable: true };
        if (ev.bytes != null) hydrated.detailBytes = ev.bytes;
        if (ev.retention_status) hydrated.rawRetentionStatus = ev.retention_status;
        out.push(hydrated);
    }
    return out;
}
export function stampTraceToolEntries(ctx: TraceCarrier & { toolLog?: ToolEntry[] }): void {
    if (!ctx.traceRunId || !Array.isArray(ctx.toolLog)) return;
    for (const tool of ctx.toolLog) stampTraceTool(tool, ctx, tool.toolType || 'tool');
}
export function finalizeTraceRun(runId: string | null | undefined, status: TraceRunStatus, error?: string | null): void {
    if (!runId || !TRACE_ID_RE.test(runId)) return;
    if (status !== 'running') closeActivity(runId);
    finalizeRunStmt.run(status, Date.now(), error || null, runId);
    seqCache.delete(runId);
}
export function linkTraceRunToMessage(runId: string | null | undefined, messageId: number): void {
    if (!runId || !TRACE_ID_RE.test(runId) || !Number.isInteger(messageId)) return;
    linkRunStmt.run(messageId, runId);
}
export function markStaleTraceRunsInterrupted(): void {
    for (const row of db.prepare("SELECT id FROM trace_runs WHERE status = 'running'").all() as { id: string }[]) {
        closeActivity(row.id);
    }
    interruptStaleStmt.run(Date.now());
    // Interrupted runs never reach finalizeTraceRun, so their seq cursors
    // stayed in seqCache forever. They receive no further events — the cache
    // can drop wholesale at this boot-time sweep (260613 05 finding 2).
    seqCache.clear();
}

// Remove on-disk spill dirs whose run no longer exists in trace_runs.
function pruneOrphanTraceDirs(): void {
    if (!fs.existsSync(TRACE_DIR) || !fs.lstatSync(TRACE_DIR).isDirectory()) return;
    const live = new Set((liveRunIdsStmt.all() as { id: string }[]).map((r) => r.id));
    for (const entry of fs.readdirSync(TRACE_DIR, { withFileTypes: true })) {
        if (!TRACE_ID_RE.test(entry.name) || !entry.isDirectory()) continue;
        const dir = join(TRACE_DIR, entry.name);
        if (!live.has(entry.name)) {
            fs.rmSync(dir, { recursive: true, force: true });
            seqCache.delete(entry.name);
            continue;
        }
        const retained = new Set((db.prepare('SELECT raw_path FROM trace_events WHERE run_id = ? AND raw_path IS NOT NULL')
            .all(entry.name) as { raw_path: string }[]).map(row => resolve(JAW_HOME, row.raw_path)));
        for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
            if (file.isFile() && /^\d{6,}\.json$/.test(file.name) && !retained.has(join(dir, file.name))) {
                fs.rmSync(join(dir, file.name));
            }
        }
    }
}

// Delete trace data older than retentionDays, then trim to maxRows, then sweep orphan spill dirs.
export function pruneTraceEvents(retentionDays = 7, maxRows = 50_000): { deletedEvents: number; deletedRuns: number } {
    try {
        const cutoff = Date.now() - retentionDays * 86_400_000;
        const result = pruneActivityTraceRows(cutoff, maxRows);
        pruneOrphanTraceDirs();
        return result;
    } catch (error) {
        console.error('[trace] prune failed:', error instanceof Error ? error.message : String(error));
        return { deletedEvents: 0, deletedRuns: 0 };
    }
}
export function getTraceRun(runId: string): TraceRunRow | null {
    if (!TRACE_ID_RE.test(runId)) return null;
    return (getRunStmt.get(runId) as TraceRunRow | undefined) || null;
}
export function listTraceEvents(runId: string, offset = 0, limit = 80): { total: number; events: TraceEventRow[] } {
    if (!TRACE_ID_RE.test(runId)) return { total: 0, events: [] };
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const totalRow = countEventsStmt.get(runId) as { count?: number } | undefined;
    return { total: Number(totalRow?.count || 0), events: listEventsStmt.all(runId, safeLimit, safeOffset) as TraceEventRow[] };
}
// ── Option D hydration (Phase 3, devlog 260620) ──────────────────────
// Reconstruct a finished assistant message's tool cards from trace_events.
// stampTraceTool stored the full ToolEntry as the event raw (source='tool'),
// so each row round-trips back to a card — durable and uncapped, unlike the
// messages.tool_log blob. raw_path spill is read lazily so huge turns still hydrate.
function traceToolEventToEntry(ev: { raw_json: string | null; raw_path: string | null }): ToolEntry | null {
    let raw = ev.raw_json || '';
    if (!raw && ev.raw_path) {
        const path = safeRawPath(ev.raw_path);
        if (path && fs.existsSync(path)) {
            try { raw = fs.readFileSync(path, 'utf8'); } catch { raw = ''; }
        }
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>;
            if (obj['label'] || obj['icon']) return obj as unknown as ToolEntry;
        }
    } catch { /* malformed payload — skip, never throw on hydrate */ }
    return null;
}

// Public hydration excludes internal (worker) runs; those fold in via parent_run_id
// once Phase 2's cross-process linkage write lands (devlog 260620 doc 20/30).
export function listToolEntriesForMessage(
    messageId: number,
    opts: { audience?: TraceAudience; limit?: number } = {},
): ToolEntry[] {
    if (!Number.isInteger(messageId) || messageId <= 0) return [];
    const wantAudience: TraceAudience = opts.audience || 'public';
    const perRunLimit = Math.max(1, Math.min(5000, opts.limit ?? 5000));
    const runs = listRunsForMessageStmt.all(messageId) as
        { id: string; audience: TraceAudience; started_at: number }[];
    const out: ToolEntry[] = [];
    for (const run of runs) {
        if (wantAudience === 'public' && run.audience === 'internal') continue;
        const events = listToolEventsForRunStmt.all(run.id, perRunLimit) as
            { seq: number; event_type: string; raw_json: string | null; raw_path: string | null;
                bytes: number; retention_status: TraceRetentionStatus }[];
        for (const ev of events) {
            const tool = traceToolEventToEntry(ev);
            if (tool) out.push({
                ...tool,
                traceRunId: run.id,
                traceSeq: ev.seq,
                detailAvailable: run.audience !== 'internal',
                detailBytes: ev.bytes,
                rawRetentionStatus: run.audience === 'internal' ? 'internal' : ev.retention_status,
            });
        }
    }
    return out;
}

export function getTraceEvent(runId: string, seq: number): (TraceEventRow & { raw: string }) | null {
    if (!TRACE_ID_RE.test(runId) || !Number.isInteger(seq) || seq < 1) return null;
    const row = getEventStmt.get(runId, seq) as TraceEventRow | undefined;
    if (!row) return null;
    let raw = row.raw_json || '';
    if (!raw && row.raw_path) {
        const path = safeRawPath(row.raw_path);
        if (!path || !fs.existsSync(path)) return { ...row, raw: '' };
        raw = fs.readFileSync(path, 'utf8');
    }
    return { ...row, raw };
}

/** Best-effort parser recovery after a tool leaves RAM; tracing cannot stop its provider. */
export function getTraceToolEntry(runId: string, seq: number): ToolEntry | null {
    if (!TRACE_ID_RE.test(runId) || !Number.isSafeInteger(seq) || seq < 1) return null;
    try {
        const row = getEventStmt.get(runId, seq) as TraceEventRow | undefined;
        if (!row || row.source !== 'tool') return null;
        const tool = traceToolEventToEntry({ raw_json: row.raw_json ?? null, raw_path: row.raw_path ?? null });
        return tool && typeof tool.label === 'string' && typeof tool.icon === 'string' && typeof tool.toolType === 'string'
            ? tool : null;
    } catch { console.warn('[trace] tool_recovery_unavailable'); return null; }
}
