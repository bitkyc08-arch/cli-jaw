// 041 — TurnStreamState pure reducer (M3.1). UI/DOM-free; the only public
// lifecycle input is TurnLifecycleSsePayload from the 032 SyncProvider
// explicit subscription. The reducer never reconnects: invalidation reasons
// arrive as explicit actions and only compute reset/backfill state.
import type { TurnSegment } from '../../../../src/shared/chat-events.ts';
import {
    adoptLiveRun,
    applyTextChunk,
    createIdempotencyState,
    isFinalizedRun,
    markRunFinalized,
    positiveSeq,
    rememberAppliedToolSeq,
    resetTransportCursors,
    shouldAcceptDone,
    shouldDropReplayedTool,
    type IdempotencyState,
} from './idempotency.ts';
import { hydrateFromMessages, mergeBody } from './hydrate.ts';
import {
    rowKey,
    type RowKey,
    type TurnStreamAction,
    type TurnStreamState,
    type TurnTerminalStatus,
} from './types.ts';

const DIAGNOSTIC_RING = 50;
const TERMINAL_STATUSES = new Set(['done', 'error', 'continued', 'interrupted']);

interface InternalState extends TurnStreamState {
    idempotency: IdempotencyState;
}

export function createTurnStreamState(scopeKey: string, sessionFilter: string | null = null): TurnStreamState {
    const state: InternalState = {
        scopeKey,
        sessionFilter,
        rows: {},
        rowOrder: [],
        turnStatus: {},
        bodies: {},
        liveBodies: {},
        needsBackfill: false,
        diagnostics: { conflictCount: 0, droppedReplayCount: 0, recent: [] },
        idempotency: createIdempotencyState(),
    };
    return state;
}

function internal(state: TurnStreamState): InternalState {
    return state as InternalState;
}

function pushDiagnostic(state: InternalState, kind: 'conflict' | 'replay', note: string): InternalState {
    const recent = [...state.diagnostics.recent, note];
    while (recent.length > DIAGNOSTIC_RING) recent.shift();
    return {
        ...state,
        diagnostics: {
            conflictCount: state.diagnostics.conflictCount + (kind === 'conflict' ? 1 : 0),
            droppedReplayCount: state.diagnostics.droppedReplayCount + (kind === 'replay' ? 1 : 0),
            recent,
        },
    };
}

function sameRow(a: TurnSegment, b: TurnSegment): boolean {
    return a.segmentId === b.segmentId
        && a.sessionId === b.sessionId
        && a.createdAt === b.createdAt
        && a.observedAt === b.observedAt
        && a.providerAt === b.providerAt
        && a.fidelity === b.fidelity
        && a.thinkingMarker === b.thinkingMarker
        && a.type === b.type
        && a.status === b.status
        && (a.detailRef?.traceRunId ?? null) === (b.detailRef?.traceRunId ?? null)
        && (a.detailRef?.traceSeq ?? null) === (b.detailRef?.traceSeq ?? null);
}

function compareKeys(a: RowKey, b: RowKey, rows: Record<RowKey, TurnSegment>): number {
    const ra = rows[a];
    const rb = rows[b];
    if (ra.turnId !== rb.turnId) return ra.turnId < rb.turnId ? -1 : 1;
    return ra.turnSeq - rb.turnSeq;
}

interface RowDraft {
    rows: Record<RowKey, TurnSegment>;
    rowOrder: RowKey[];
    turnStatus: Record<string, TurnTerminalStatus>;
    conflicts: string[];
}

/** Clone the row tables ONCE per action; rows within one action apply
 *  mutably to the clone (a 10k history page stays O(n log n), not O(n^2)). */
function draftRows(state: InternalState): RowDraft {
    return {
        rows: { ...state.rows },
        rowOrder: [...state.rowOrder],
        turnStatus: { ...state.turnStatus },
        conflicts: [],
    };
}

/** Insert one durable row: identical duplicate = no-op; conflicting duplicate
 *  keeps the FIRST durable row and records a diagnostic (invariant 3). */
function insertRowMut(draft: RowDraft, row: TurnSegment): void {
    const key = rowKey(row.turnId, row.turnSeq);
    const existing = draft.rows[key];
    if (existing) {
        if (!sameRow(existing, row)) draft.conflicts.push(`conflict ${key}`);
        return;
    }
    draft.rows[key] = row;
    // binary insert into canonical (turnId, turnSeq) order
    let lo = 0;
    let hi = draft.rowOrder.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareKeys(draft.rowOrder[mid], key, draft.rows) < 0) lo = mid + 1;
        else hi = mid;
    }
    draft.rowOrder.splice(lo, 0, key);
    if (row.type === 'turn_end' && TERMINAL_STATUSES.has(row.status)) {
        draft.turnStatus[row.turnId] = row.status as TurnTerminalStatus;
    }
}

function commitDraft(state: InternalState, draft: RowDraft): InternalState {
    let next: InternalState = {
        ...state,
        rows: draft.rows,
        rowOrder: draft.rowOrder,
        turnStatus: draft.turnStatus,
    };
    for (const note of draft.conflicts) next = pushDiagnostic(next, 'conflict', note);
    return next;
}

export function reduce(state: TurnStreamState, action: TurnStreamAction): TurnStreamState {
    const s = internal(state);
    switch (action.kind) {
        case 'lifecycle': {
            const { topic: _topic, event: _event, sseReplay: _replay, ...row } = action.payload;
            // invariant 2: events from another scope leave the state hash unchanged
            if (s.sessionFilter !== null && row.sessionId !== s.sessionFilter) return s;
            const draft = draftRows(s);
            insertRowMut(draft, row);
            return commitDraft(s, draft);
        }
        case 'body_chunk': {
            const result = applyTextChunk(s.idempotency, action);
            let next: InternalState = { ...s, idempotency: result.state };
            if (result.appendText === null) {
                return result.resynced ? next : pushDiagnostic(next, 'replay', 'body replay/duplicate');
            }
            if (action.traceRunId) {
                const liveBodies = {
                    ...next.liveBodies,
                    [action.traceRunId]: (next.liveBodies[action.traceRunId] ?? '') + result.appendText,
                };
                next = { ...next, liveBodies };
            }
            return next;
        }
        case 'tool_event': {
            const runId = action.traceRunId;
            const seq = positiveSeq(action.traceSeq);
            if (isFinalizedRun(s.idempotency, runId)) return pushDiagnostic(s, 'replay', 'tool on finalized run');
            if (shouldDropReplayedTool(s.idempotency, runId, seq)) {
                return pushDiagnostic(s, 'replay', 'tool seq replay');
            }
            let idem = s.idempotency;
            // Employee mirror events carry the EMPLOYEE's run id — adopting it
            // would reset the boss text cursor (invariant: employee non-adoption).
            if (action.isEmployee !== true) idem = adoptLiveRun(idem, runId);
            idem = rememberAppliedToolSeq(idem, runId, seq);
            const afterTool: InternalState = { ...s, idempotency: idem };
            return afterTool;
        }
        case 'agent_done': {
            if (action.steered === true) return s;
            if (!shouldAcceptDone(s.idempotency, action.traceRunId)) {
                return pushDiagnostic(s, 'replay', 'stale/finalized agent_done');
            }
            let next: InternalState = { ...s, idempotency: markRunFinalized(s.idempotency, action.traceRunId) };
            if (action.traceRunId) {
                const liveBodies = { ...next.liveBodies, [action.traceRunId]: action.text };
                next = { ...next, liveBodies };
            }
            return next;
        }
        case 'history_page': {
            const hydration = hydrateFromMessages(action.messages);
            const draft = draftRows(s);
            for (const row of hydration.rows) insertRowMut(draft, row);
            let next = commitDraft(s, draft);
            const bodies = { ...next.bodies };
            for (const [turnId, body] of Object.entries(hydration.bodies)) {
                bodies[turnId] = mergeBody(bodies[turnId], body);
            }
            return { ...next, bodies };
        }
        case 'backfill_merged':
            return s.needsBackfill ? { ...s, needsBackfill: false } : s;
        case 'invalidation': {
            switch (action.reason) {
                case 'replay_gap':
                    // keep durable rows; only 048 page merge lowers the flag
                    return { ...s, needsBackfill: true };
                case 'reconnect':
                    { const reconnected: InternalState = { ...s, idempotency: resetTransportCursors(s.idempotency), liveBodies: {} }; return reconnected; }
                case 'port_change':
                    // dispose previous scope state entirely (invariant: port_change)
                    return internal(createTurnStreamState(s.scopeKey, s.sessionFilter));
                default:
                    return s;
            }
        }
        default:
            return s;
    }
}

/** Canonical serialization for convergence tests: independent of arrival
 *  order, includes ordered durable rows, terminal statuses, and bodies. */
export function serializeState(state: TurnStreamState): string {
    const rows = state.rowOrder.map(key => {
        const r = state.rows[key];
        return [r.turnId, r.turnSeq, r.segmentId, r.sessionId, r.createdAt, r.observedAt,
            r.providerAt, r.fidelity, r.thinkingMarker, r.type, r.status,
            r.detailRef ? [r.detailRef.traceRunId, r.detailRef.traceSeq] : null];
    });
    const turnStatus = Object.keys(state.turnStatus).sort()
        .map(turnId => [turnId, state.turnStatus[turnId]]);
    const bodies = Object.keys(state.bodies).sort()
        .map(turnId => {
            const b = state.bodies[turnId];
            return [turnId, b.text, b.toolLog, b.provenance, b.traceRunId];
        });
    return JSON.stringify({ scopeKey: state.scopeKey, rows, turnStatus, bodies, needsBackfill: state.needsBackfill });
}
