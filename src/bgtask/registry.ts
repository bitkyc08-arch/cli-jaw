// ─── bgtask: registry (DB CRUD + state transitions) ──
// Table DDL lives in src/core/db.ts (background_tasks). Prepared statements
// stay module-local to keep db.ts within its size budget.

import { randomUUID } from 'node:crypto';
import { db } from '../core/db.js';
import { broadcast } from '../core/bus.js';
import {
    dedupKeyForSpec,
    type BgTaskRow,
    type BgTaskSpec,
    type BgTaskStatus,
    type OriginMeta,
} from './types.js';

const insertStmt = db.prepare(`
    INSERT INTO background_tasks (id, kind, spec, status, origin_meta, deadline_at, started_at)
    VALUES (?, ?, ?, 'running', ?, ?, CURRENT_TIMESTAMP)
`);
const getStmt = db.prepare('SELECT * FROM background_tasks WHERE id = ?');
const listAllStmt = db.prepare('SELECT * FROM background_tasks ORDER BY created_at DESC LIMIT ?');
const listByStatusStmt = db.prepare('SELECT * FROM background_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?');
const setPidStmt = db.prepare('UPDATE background_tasks SET pid = ? WHERE id = ?');
const completeStmt = db.prepare(`
    UPDATE background_tasks SET status = ?, result = ?, pid = NULL, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
`);
const cancelStmt = db.prepare(`
    UPDATE background_tasks SET status = 'cancelled', pid = NULL, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
`);
const orphanStmt = db.prepare(`
    UPDATE background_tasks SET status = 'orphaned', pid = NULL, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
`);
const notifiedStmt = db.prepare('UPDATE background_tasks SET notified_at = CURRENT_TIMESTAMP WHERE id = ?');
const recoverableStmt = db.prepare(`
    SELECT * FROM background_tasks
    WHERE status = 'running'
       OR (status IN ('complete', 'failed') AND notified_at IS NULL)
    ORDER BY created_at ASC
`);
const activeStmt = db.prepare("SELECT * FROM background_tasks WHERE status = 'running'");

interface RawRow {
    id: string;
    kind: string;
    spec: string;
    status: string;
    pid: number | null;
    origin_meta: string | null;
    result: string | null;
    created_at: string | null;
    started_at: string | null;
    deadline_at: string | null;
    completed_at: string | null;
    notified_at: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function toRow(raw: RawRow): BgTaskRow {
    return {
        id: raw.id,
        kind: raw.kind,
        spec: parseJson<BgTaskSpec>(raw.spec, { completion: { type: 'exit' }, promptTemplate: '' }),
        status: raw.status as BgTaskStatus,
        pid: raw.pid ?? null,
        originMeta: parseJson<OriginMeta>(raw.origin_meta, {}),
        result: raw.result ?? null,
        createdAt: raw.created_at ?? null,
        startedAt: raw.started_at ?? null,
        deadlineAt: raw.deadline_at ?? null,
        completedAt: raw.completed_at ?? null,
        notifiedAt: raw.notified_at ?? null,
    };
}

/** UI surfacing: every externally-visible state transition emits bgtask_update
 * (SSE topic 'bgtask'). running[] is the authoritative live set; changed carries
 * the transitioned task so clients can flash/retain without server-side timers. */
function emitBgtaskUpdate(changedId?: string): void {
    try {
        const running = (activeStmt.all() as RawRow[]).map(toRow).map((r) => ({
            id: r.id, kind: r.kind, startedAt: r.startedAt,
        }));
        const changedRow = changedId ? getTask(changedId) : null;
        broadcast('bgtask_update', {
            running,
            changed: changedRow
                ? { id: changedRow.id, kind: changedRow.kind, status: changedRow.status }
                : null,
        });
    } catch (err) {
        console.error('[bgtask] broadcast failed:', (err as Error).message);
    }
}

export class DuplicateBgTaskError extends Error {
    public existingId: string;
    constructor(existingId: string) {
        super(`an active background task already covers this work (${existingId})`);
        this.name = 'DuplicateBgTaskError';
        this.existingId = existingId;
    }
}

export function findActiveDuplicate(spec: BgTaskSpec): BgTaskRow | null {
    const key = dedupKeyForSpec(spec);
    for (const raw of activeStmt.all() as RawRow[]) {
        const row = toRow(raw);
        if (dedupKeyForSpec(row.spec) === key) return row;
    }
    return null;
}

export function createTask(input: { kind: string; spec: BgTaskSpec; originMeta?: OriginMeta | null }): BgTaskRow {
    const duplicate = findActiveDuplicate(input.spec);
    if (duplicate) throw new DuplicateBgTaskError(duplicate.id);
    const id = `bg_${randomUUID()}`;
    insertStmt.run(
        id,
        input.kind,
        JSON.stringify(input.spec),
        JSON.stringify(input.originMeta ?? {}),
        input.spec.deadlineAt ?? null,
    );
    const row = getTask(id);
    if (!row) throw new Error(`bgtask insert failed for ${id}`);
    emitBgtaskUpdate(id);
    return row;
}

export function getTask(id: string): BgTaskRow | null {
    const raw = getStmt.get(id) as RawRow | undefined;
    return raw ? toRow(raw) : null;
}

export function listTasks(filter: { status?: BgTaskStatus; limit?: number } = {}): BgTaskRow[] {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    const rows = (filter.status
        ? listByStatusStmt.all(filter.status, limit)
        : listAllStmt.all(limit)) as RawRow[];
    return rows.map(toRow);
}

export function setTaskPid(id: string, pid: number | null): void {
    setPidStmt.run(pid, id);
}

/** Transition running → complete/failed. Returns false if the task was not running
 * (already terminal or cancelled) — callers must not double-notify in that case. */
export function markTerminal(id: string, status: 'complete' | 'failed', result: string | null): boolean {
    const transitioned = completeStmt.run(status, result, id).changes > 0;
    if (transitioned) emitBgtaskUpdate(id);
    return transitioned;
}

export function markCancelled(id: string): boolean {
    const changed = cancelStmt.run(id).changes > 0;
    if (changed) emitBgtaskUpdate(id);
    return changed;
}

export function markOrphaned(id: string): boolean {
    const changed = orphanStmt.run(id).changes > 0;
    if (changed) emitBgtaskUpdate(id);
    return changed;
}

export function markNotified(id: string): void {
    const changed = notifiedStmt.run(id).changes > 0;
    if (changed) emitBgtaskUpdate(id);
}

/** Boot recovery set: still-running tasks + terminal tasks never notified. */
export function loadRecoverable(): BgTaskRow[] {
    return (recoverableStmt.all() as RawRow[]).map(toRow);
}
