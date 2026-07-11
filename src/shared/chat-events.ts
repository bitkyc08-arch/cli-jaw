export interface MessageItem {
    id?: number | string;
    role: string;
    content: string;
    source?: string | null;
    kind?: string | null;
    tool_log?: string | null;
    trace_run_id?: string | null;
    cli?: string | null;
}

export interface ToolLogEntry {
    icon: string;
    rawIcon?: string;
    label: string;
    detail?: string;
    toolType?: string;
    stepRef?: string;
    status?: string;
    isEmployee?: boolean;
    traceRunId?: string;
    traceSeq?: number;
    detailAvailable?: boolean;
    detailBytes?: number;
    rawRetentionStatus?: string;
}

export interface ActiveRunSnapshot {
    running?: boolean;
    cli?: string;
    text?: string;
    textLen?: number;
    toolLog?: ToolLogEntry[];
    startedAt?: number;
    traceRunId?: string;
}

interface PendingItemFields {
    id: string;
    prompt: string;
    ts?: number;
}

export type PendingItem = PendingItemFields & (
    | { source: 'web' }
    | { source: 'cli' }
    | { source: 'system' }
    | { source: 'bgtask' }
    | { source: 'telegram' }
    | { source: 'discord' }
);

export type KnownTurnSegmentType = 'assistant_text' | 'thinking' | 'tool' | 'turn_start' | 'turn_end';
export type TurnSegmentType = KnownTurnSegmentType | (string & Record<never, never>);
export type KnownTurnSegmentStatus = 'running' | 'done' | 'error' | 'continued' | 'interrupted';
export type TurnSegmentStatus = KnownTurnSegmentStatus | (string & Record<never, never>);
export type TurnFidelity = 'full' | 'coarse' | 'text_only';
export type KnownThinkingMarker = 'streaming' | 'plaintext' | 'encrypted' | 'token_fallback' | 'pre_tool_text' | 'plan' | 'planner';
export type ThinkingMarker = KnownThinkingMarker | (string & Record<never, never>);

export interface TurnSegmentDetailRef {
    traceRunId: string;
    traceSeq: number;
}

export interface TurnSegment {
    turnId: string;
    turnSeq: number;
    segmentId: string;
    sessionId: string;
    createdAt: number;
    observedAt: number;
    providerAt: number | null;
    fidelity: TurnFidelity | null;
    thinkingMarker: ThinkingMarker | null;
    type: TurnSegmentType;
    status: TurnSegmentStatus;
    detailRef: TurnSegmentDetailRef | null;
}

// ─── Bounded history page (032.0 / A08) ─────────────────────────────
// Canonical row shape of GET /api/messages?includeSegments=1 (cursor mode).
// Field list mirrors the segment/cursor SELECT in src/core/db.ts; the
// `turn_segments` array carries durable TurnSegment rows keyed (turnId,turnSeq).

export interface SegmentedMessageItem {
    id: number;
    role: string;
    content: string;
    cli: string | null;
    model: string | null;
    tool_log: string | null;
    trace_run_id: string | null;
    turn_id: string | null;
    cost_usd: number | null;
    duration_ms: number | null;
    working_dir: string | null;
    created_at: string;
    turn_segments: TurnSegment[];
}

export interface MessagesPageInfo {
    oldestCursor: number | null;
    newestCursor: number | null;
    hasMoreBefore: boolean;
    limit: number;
}

// snapshotEventSeq is a non-atomic reconnect diagnostic hint only —
// consumers must merge idempotently, never treat it as a fence.
export interface MessagesPageResponse {
    ok: true;
    data: SegmentedMessageItem[];
    pageInfo: MessagesPageInfo;
    snapshotEventSeq: number;
}

interface SsePayloadBase {
    topic: string;
    sseReplay?: boolean;
}

export type AgentOutputSsePayload = SsePayloadBase & {
    event: 'agent_output' | 'agent_chunk';
    agentId?: string;
    cli?: string;
    text: string;
    traceRunId?: string;
    textLen?: number;
    isEmployee?: boolean;
};

export type AgentToolSsePayload = SsePayloadBase & ToolLogEntry & {
    event: 'agent_tool';
    agentId?: string;
    cli?: string;
    startedAt?: number;
};

export type AgentStatusSsePayload = SsePayloadBase & {
    event: 'agent_status';
    agentId?: string;
    cli?: string;
    running?: boolean;
    status?: string;
    phase?: string;
    isEmployee?: boolean;
};

export type AgentDoneSsePayload = SsePayloadBase & {
    event: 'agent_done';
    text: string;
    toolLog?: ToolLogEntry[];
    traceRunId?: string;
    error?: boolean;
    steered?: boolean;
    origin?: string;
    isEmployee?: boolean;
};

export type AgentRetrySsePayload = SsePayloadBase & {
    event: 'agent_retry';
    cli?: string;
    delay?: number;
    reason?: string;
    attempt?: number;
    maxRetries?: number;
    isEmployee?: boolean;
};

export type AgentFallbackSsePayload = SsePayloadBase & {
    event: 'agent_fallback';
    from: string;
    to: string;
    reason?: string;
    isEmployee?: boolean;
};

export type QueueUpdateSsePayload = SsePayloadBase & {
    event: 'queue_update';
    pending: number;
    queued: PendingItem[];
};

// ─── Turn lifecycle SSE (032.3) ──────────────────────────────────────
// `agent` topic turn stream: the payload is the durable TurnSegment row
// spread into the envelope (publishTurnRecord in src/agent/events/helpers.ts).
// Kept OUT of ChatSsePayload on purpose — legacy consumers dispatch on the
// closed union; turn-stream consumers (dashboard2) subscribe explicitly.

export type TurnLifecycleSseEvent = 'turn_start' | 'turn_segment' | 'turn_end';

export type TurnLifecycleSsePayload = SsePayloadBase & TurnSegment & {
    event: TurnLifecycleSseEvent;
};

export type ChatSsePayload =
    | AgentOutputSsePayload
    | AgentToolSsePayload
    | AgentStatusSsePayload
    | AgentDoneSsePayload
    | AgentRetrySsePayload
    | AgentFallbackSsePayload
    | QueueUpdateSsePayload;
