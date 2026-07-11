// 041 — replay idempotency cursors, ported as PURE functions from
// public/js/ws.ts:123-180,927-996,1042-1055 (REFERENCE ONLY — vanilla frozen).
// No window/document/fetch/react imports; every transition returns new state.

export const FINALIZED_RUN_MEMORY = 8;
// 64: employee tool mirrors each carry a traceRunId — a smaller ring could
// evict the BOSS run's cursor mid-run and disable the replay guard.
export const TOOL_SEQ_RUN_MEMORY = 64;

export interface IdempotencyState {
    liveTraceRunId: string | null;
    /** server-side cumulative applied text length for the live run */
    liveAppliedTextLen: number;
    /** finalized run ring, newest last (cap FINALIZED_RUN_MEMORY) */
    finalizedTraceRuns: string[];
    /** max applied traceSeq per run id (cap TOOL_SEQ_RUN_MEMORY, boss pinned) */
    appliedToolSeqByRun: Record<string, number>;
}

export function createIdempotencyState(): IdempotencyState {
    return {
        liveTraceRunId: null,
        liveAppliedTextLen: 0,
        finalizedTraceRuns: [],
        appliedToolSeqByRun: {},
    };
}

export function positiveSeq(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function isFinalizedRun(state: IdempotencyState, runId: string | null): boolean {
    return runId !== null && state.finalizedTraceRuns.includes(runId);
}

/** Adopt a run as the live boss run; resets the text cursor on run change. */
export function adoptLiveRun(state: IdempotencyState, runId: string | null): IdempotencyState {
    if (!runId || state.liveTraceRunId === runId) return state;
    return { ...state, liveTraceRunId: runId, liveAppliedTextLen: 0 };
}

export function rememberAppliedToolSeq(
    state: IdempotencyState,
    runId: string | null,
    seq: number | null,
): IdempotencyState {
    if (!runId || seq == null) return state;
    const prev = state.appliedToolSeqByRun[runId] ?? 0;
    if (seq <= prev) return state;
    const next = { ...state.appliedToolSeqByRun, [runId]: seq };
    const keys = Object.keys(next);
    if (keys.length > TOOL_SEQ_RUN_MEMORY) {
        // Pin the live boss run: evicting its cursor mid-run would disable
        // the replay guard exactly when it matters.
        for (const key of keys) {
            if (key !== state.liveTraceRunId) { delete next[key]; break; }
        }
    }
    return { ...state, appliedToolSeqByRun: next };
}

/** Replayed/duplicate tool events at or below the applied cursor are no-ops. */
export function shouldDropReplayedTool(
    state: IdempotencyState,
    runId: string | null,
    seq: number | null,
): boolean {
    if (!runId || seq == null) return false;
    return seq <= (state.appliedToolSeqByRun[runId] ?? 0);
}

export interface TextChunkResult {
    state: IdempotencyState;
    /** unseen tail to append, or null when the chunk is a no-op */
    appendText: string | null;
    /** live cursor was behind server cumulative length and resynced */
    resynced: boolean;
}

/**
 * Cumulative `textLen` duplicate/partial-overlap handling (ws.ts:970-996).
 * `textLen` is the server cumulative length AFTER this chunk. At or below the
 * applied cursor the block already renders it (replay) — but a LIVE chunk
 * behind the cursor means desync: resync the cursor so the next chunk can
 * append its tail, and drop only the already-rendered content.
 */
export function applyTextChunk(
    state: IdempotencyState,
    chunk: {
        traceRunId: string | null;
        text: string;
        textLen?: number | undefined;
        sseReplay?: boolean | undefined;
        isEmployee?: boolean | undefined;
    },
): TextChunkResult {
    const runId = chunk.traceRunId;
    if (isFinalizedRun(state, runId)) return { state, appendText: null, resynced: false };
    let next = chunk.isEmployee === true ? state : adoptLiveRun(state, runId);
    let text = chunk.text;
    if (runId && typeof chunk.textLen === 'number') {
        if (chunk.textLen <= next.liveAppliedTextLen) {
            if (chunk.sseReplay !== true && chunk.textLen < next.liveAppliedTextLen) {
                next = { ...next, liveAppliedTextLen: chunk.textLen };
                return { state: next, appendText: null, resynced: true };
            }
            return { state: next, appendText: null, resynced: false };
        }
        const missing = chunk.textLen - next.liveAppliedTextLen;
        if (missing < text.length) text = text.slice(-missing);
        next = { ...next, liveAppliedTextLen: chunk.textLen };
    }
    return { state: next, appendText: text, resynced: false };
}

export function markRunFinalized(state: IdempotencyState, runId: string | null): IdempotencyState {
    if (!runId) return state;
    if (state.finalizedTraceRuns.includes(runId)) return state;
    const ring = [...state.finalizedTraceRuns, runId];
    while (ring.length > FINALIZED_RUN_MEMORY) ring.shift();
    return { ...state, finalizedTraceRuns: ring };
}

/**
 * Finalized/stale `agent_done` guard (ws.ts:1042-1055): a done for an
 * already-finalized run is a replay; a done carrying a DIFFERENT run id than
 * the live stream is a stale replay from a previous turn and must not close
 * the live turn.
 */
export function shouldAcceptDone(state: IdempotencyState, runId: string | null): boolean {
    if (isFinalizedRun(state, runId)) return false;
    if (runId && state.liveTraceRunId && runId !== state.liveTraceRunId) return false;
    return true;
}

/** reconnect/port_change invalidation: reset partial transport cursors only. */
export function resetTransportCursors(state: IdempotencyState): IdempotencyState {
    return { ...state, liveTraceRunId: null, liveAppliedTextLen: 0, appliedToolSeqByRun: {} };
}
