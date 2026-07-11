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

export type KnownTurnSegmentType = 'assistant_text' | 'thinking' | 'tool';
export type TurnSegmentType = KnownTurnSegmentType | (string & Record<never, never>);
export type KnownTurnSegmentStatus = 'running' | 'done' | 'error';
export type TurnSegmentStatus = KnownTurnSegmentStatus | (string & Record<never, never>);

export interface TurnSegmentDetailRef {
    traceRunId: string;
    traceSeq: number;
}

export interface TurnSegment {
    turnId: string;
    turnSeq: number;
    type: TurnSegmentType;
    status: TurnSegmentStatus;
    detailRef: TurnSegmentDetailRef | null;
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

export type ChatSsePayload =
    | AgentOutputSsePayload
    | AgentToolSsePayload
    | AgentStatusSsePayload
    | AgentDoneSsePayload
    | AgentRetrySsePayload
    | AgentFallbackSsePayload
    | QueueUpdateSsePayload;
