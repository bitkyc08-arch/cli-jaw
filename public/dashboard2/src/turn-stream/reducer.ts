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
// bounded body retention inside the reducer itself — the 042 TurnStore owns
// the real T2/T3 budgets; these caps only stop unbounded reducer growth
const LIVE_BODY_RUNS = 16;
const HYDRATED_BODY_TURNS = 1024;

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
        runToTurn: {},
        legacyMessages: {},
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
    joins: Array<[string, string]>;
}

/** Clone the row tables ONCE per action; rows within one action apply
 *  mutably to the clone (a 10k history page stays O(n log n), not O(n^2)). */
function draftRows(state: InternalState): RowDraft {
    return {
        rows: { ...state.rows },
        rowOrder: [...state.rowOrder],
        turnStatus: { ...state.turnStatus },
        conflicts: [],
        joins: [],
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
    if (row.detailRef) draft.joins.push([row.detailRef.traceRunId, row.turnId]);
}

function commitDraft(state: InternalState, draft: RowDraft): InternalState {
    let next: InternalState = {
        ...state,
        rows: draft.rows,
        rowOrder: draft.rowOrder,
        turnStatus: draft.turnStatus,
    };
    if (draft.joins.length) {
        const runToTurn = { ...state.runToTurn };
        for (const [runId, turnId] of draft.joins) runToTurn[runId] = turnId;
        next = { ...next, runToTurn };
    }
    for (const note of draft.conflicts) next = pushDiagnostic(next, 'conflict', note);
    return next;
}

/** join-at-finalize: an unjoined run with exactly ONE live turn is
 *  unambiguous — persist the join so ring evictions can never reclassify
 *  the retained body as active later (long sessions, steered runs) */
function joinRunToOnlyLiveTurn(state: InternalState, runId: string): InternalState {
    if (runId in state.runToTurn) return state;
    const liveTurnIds = new Set<string>();
    for (const key of state.rowOrder) {
        const turnId = state.rows[key].turnId;
        if (!state.turnStatus[turnId]) liveTurnIds.add(turnId);
    }
    if (liveTurnIds.size !== 1) return state;
    const [only] = liveTurnIds;
    return { ...state, runToTurn: { ...state.runToTurn, [runId]: only } };
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
                next = { ...next, liveBodies: capLiveBodies(liveBodies, action.traceRunId) };
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
            if (action.steered === true) {
                // suppressed output — but the run is DEAD: finalize + join so
                // its retained body never poisons the unambiguous fallback
                if (!action.traceRunId) return s;
                let steered: InternalState = { ...s, idempotency: markRunFinalized(s.idempotency, action.traceRunId) };
                steered = joinRunToOnlyLiveTurn(steered, action.traceRunId);
                return steered;
            }
            if (!shouldAcceptDone(s.idempotency, action.traceRunId)) {
                return pushDiagnostic(s, 'replay', 'stale/finalized agent_done');
            }
            let next: InternalState = { ...s, idempotency: markRunFinalized(s.idempotency, action.traceRunId) };
            if (action.traceRunId) {
                const liveBodies = { ...next.liveBodies, [action.traceRunId]: action.text };
                next = { ...next, liveBodies: capLiveBodies(liveBodies, action.traceRunId) };
                next = joinRunToOnlyLiveTurn(next, action.traceRunId);
            }
            return next;
        }
        case 'history_page': {
            const hydration = hydrateFromMessages(action.messages);
            const draft = draftRows(s);
            for (const row of hydration.rows) insertRowMut(draft, row);
            let next = commitDraft(s, draft);
            const bodies = { ...next.bodies };
            const runToTurn = { ...next.runToTurn };
            for (const [turnId, body] of Object.entries(hydration.bodies)) {
                bodies[turnId] = mergeBody(bodies[turnId], body);
                if (body.traceRunId) runToTurn[body.traceRunId] = turnId;
            }
            let legacyMessages = next.legacyMessages;
            if (hydration.legacy.length) {
                legacyMessages = { ...legacyMessages };
                for (const row of hydration.legacy) {
                    legacyMessages[row.id] = { role: row.role, content: row.content, createdAt: row.createdAt };
                }
            }
            return { ...next, bodies: capBodies(bodies), runToTurn, legacyMessages };
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
    return serializeStateImpl(state);
}

/** Batch application: consecutive lifecycle actions share ONE row-table
 *  clone, keeping bulk ingest (042 store fold) O(n log n) instead of O(n^2). */
export function reduceBatch(state: TurnStreamState, actions: readonly TurnStreamAction[]): TurnStreamState {
    return reduceBatchImpl(state, actions);
}

/** live bodies that are neither joined to a turn nor from a finalized run —
 *  the 042 store's unambiguous-pairing fallback consumes exactly these */
export function unjoinedActiveLiveBodies(state: TurnStreamState): Array<[string, string]> {
    const finalized = internal(state).idempotency.finalizedTraceRuns;
    return Object.entries(state.liveBodies).filter(([runId]) =>
        !(runId in state.runToTurn) && !finalized.includes(runId));
}

function reduceBatchImpl(state: TurnStreamState, actions: readonly TurnStreamAction[]): TurnStreamState {
    let s = state;
    let i = 0;
    while (i < actions.length) {
        const action = actions[i];
        if (action.kind !== 'lifecycle') {
            s = reduce(s, action);
            i += 1;
            continue;
        }
        const si = internal(s);
        const draft = draftRows(si);
        while (i < actions.length) {
            const next = actions[i];
            if (next.kind !== 'lifecycle') break;
            const { topic: _topic, event: _event, sseReplay: _replay, ...row } = next.payload;
            if (si.sessionFilter === null || row.sessionId === si.sessionFilter) {
                insertRowMut(draft, row);
            }
            i += 1;
        }
        s = commitDraft(si, draft);
    }
    return s;
}

function serializeStateImpl(state: TurnStreamState): string {
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
    const runToTurn = Object.keys(state.runToTurn).sort()
        .map(runId => [runId, state.runToTurn[runId]]);
    const legacy = Object.keys(state.legacyMessages).map(Number).sort((a, b) => a - b)
        .map(id => [id, state.legacyMessages[id].role, state.legacyMessages[id].content]);
    return JSON.stringify({ scopeKey: state.scopeKey, rows, turnStatus, bodies, runToTurn, legacy, needsBackfill: state.needsBackfill });
}
function capLiveBodies(liveBodies: Record<string, string>, keep: string | null): Record<string, string> {
    const keys = Object.keys(liveBodies);
    if (keys.length <= LIVE_BODY_RUNS) return liveBodies;
    const next = { ...liveBodies };
    for (const key of keys) {
        if (Object.keys(next).length <= LIVE_BODY_RUNS) break;
        if (key !== keep) delete next[key];
    }
    return next;
}

function capBodies(bodies: Record<string, import('./types.ts').HydratedTurnBody>): Record<string, import('./types.ts').HydratedTurnBody> {
    const keys = Object.keys(bodies);
    if (keys.length <= HYDRATED_BODY_TURNS) return bodies;
    const next = { ...bodies };
    for (const key of keys) {
        if (Object.keys(next).length <= HYDRATED_BODY_TURNS) break;
        delete next[key];
    }
    return next;
}

/** collect traceRunId→turnId joins from durable rows carrying detailRef */
function joinFromRow(runToTurn: Record<string, string>, row: TurnSegment): Record<string, string> {
    if (!row.detailRef) return runToTurn;
    const runId = row.detailRef.traceRunId;
    if (runToTurn[runId] === row.turnId) return runToTurn;
    return { ...runToTurn, [runId]: row.turnId };
}
