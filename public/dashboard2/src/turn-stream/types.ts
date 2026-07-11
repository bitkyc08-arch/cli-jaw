// 041 — dashboard2-owned turn-stream model types (M3.1).
// Canonical DTOs stay in src/shared/chat-events.ts (type-only imports; no
// third copy). This module owns only reducer projections and render models.
import type {
    SegmentedMessageItem,
    TurnLifecycleSsePayload,
    TurnSegment,
} from '../../../../src/shared/chat-events.ts';

// Durable row identity is (turnId, turnSeq) — NEVER segmentId or SSE event id
// (invariant 8 / A02). The factory is the only sanctioned key constructor.
export type RowKey = string;
export function rowKey(turnId: string, turnSeq: number): RowKey {
    return `${turnId}#${turnSeq}`;
}

export type BodyProvenance = 'message' | 'live' | 'trace';

export interface HydratedTurnBody {
    text: string;
    toolLog: string | null;
    provenance: BodyProvenance;
    traceRunId: string | null;
}

export type TurnTerminalStatus = 'done' | 'error' | 'continued' | 'interrupted';

export type SyncInvalidationReason = 'replay_gap' | 'reconnect' | 'port_change';

// Normalized reducer actions. The lifecycle channel is the explicit
// TurnLifecycleSsePayload subscription (034 §1.3); legacy body channels are
// normalized by the D21 hydration adapter — the reducer never touches raw
// MessageEvent, topic dispatchers, or the legacy ChatSsePayload union.
export type TurnStreamAction =
    | { kind: 'lifecycle'; payload: TurnLifecycleSsePayload }
    | {
        kind: 'body_chunk';
        traceRunId: string | null;
        text: string;
        textLen?: number | undefined;
        sseReplay?: boolean | undefined;
        isEmployee?: boolean | undefined;
    }
    | {
        kind: 'tool_event';
        traceRunId: string | null;
        traceSeq: number | null;
        sseReplay?: boolean | undefined;
        isEmployee?: boolean | undefined;
    }
    | { kind: 'agent_done'; traceRunId: string | null; text: string; steered?: boolean | undefined }
    | { kind: 'history_page'; messages: SegmentedMessageItem[] }
    | { kind: 'backfill_merged' }
    | { kind: 'invalidation'; reason: SyncInvalidationReason };

export interface TurnStreamDiagnostics {
    conflictCount: number;
    droppedReplayCount: number;
    /** most recent diagnostics, bounded ring (cap 50) */
    recent: string[];
}

export interface TurnStreamState {
    /** `${instancePort}/${sessionId}` — injected by 032 SyncProvider (invariant 1) */
    scopeKey: string;
    /** when set, lifecycle rows from other sessions are ignored (invariant 2);
     *  null accepts any session (single-session instance scope) */
    sessionFilter: string | null;
    /** durable rows keyed by (turnId,turnSeq) */
    rows: Record<RowKey, TurnSegment>;
    /** canonical order: sorted by turnId then turnSeq (arrival-order independent) */
    rowOrder: RowKey[];
    /** terminal status per turn — set only by that turn's turn_end (invariant 5) */
    turnStatus: Record<string, TurnTerminalStatus>;
    /** hydrated bodies keyed by turnId; message provenance beats live */
    bodies: Record<string, HydratedTurnBody>;
    /** live streaming text keyed by traceRunId (no turn join yet) */
    liveBodies: Record<string, string>;
    /** traceRunId → turnId join, built from message hydration (trace_run_id +
     *  turn_id) and lifecycle detailRef rows; lets the live tail map a
     *  streaming body to its turn */
    runToTurn: Record<string, string>;
    /** turn_id=null legacy history rows — text preserved with empty segments
     *  (048 §4); rendering integration is owned by the 07x cutover */
    legacyMessages: Record<number, { role: string; content: string; createdAt: string }>;
    needsBackfill: boolean;
    diagnostics: TurnStreamDiagnostics;
}
