export type TraceAudience = 'public' | 'internal';
export type TraceRunStatus = 'running' | 'done' | 'error' | 'interrupted';
export type TraceRetentionStatus = 'available' | 'spilled' | 'redacted' | 'internal' | 'missing';
export type TraceEventSource = 'runtime' | 'cli_raw' | 'acp_raw' | 'codex_app_raw' | 'tool' | 'stderr' | 'system';

export interface TraceRunInput {
    cli: string;
    model?: string | null;
    workingDir?: string | null;
    agentLabel?: string | null;
    audience?: TraceAudience;
    parentRunId?: string | null;
}

export interface TraceEventInput {
    runId?: string | null | undefined;
    source: TraceEventSource;
    eventType: string;
    raw: unknown;
    preview?: string | undefined;
}

export interface TracePointer {
    traceRunId: string;
    traceSeq: number;
    detailAvailable: boolean;
    detailBytes: number;
    rawRetentionStatus: TraceRetentionStatus;
}

export interface TraceCarrier {
    traceRunId?: string;
    traceSeq?: number;
    traceAudience?: TraceAudience;
    traceRetentionStatus?: TraceRetentionStatus;
}
