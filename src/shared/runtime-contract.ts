export type RuntimeTransport = 'native' | 'print';
export type RuntimeSteerMode = 'native-input' | 'cancel-reprompt' | 'queued' | 'restart';
export type RuntimePhase = 'commentary' | 'final' | 'unknown';
export type RuntimeItemStatus = 'running' | 'done' | 'error' | 'stopped';
/** Private owned-I/O callback identity. Never a wire event or content carrier. */
export interface RuntimeLivenessIdentity {
    runId: string;
    sessionId: string;
    scope: string;
    origin: string;
    requestId?: string;
}
export interface RuntimeTurnOutcome {
    status: 'done' | 'error' | 'stopped';
    /** null means absent; an empty string is an authoritative empty answer. */
    finalText: string | null;
    /** Incomplete assistant output for salvage, never an implicit final answer. */
    partialText: string;
}
export interface RuntimeCapabilities {
    transport: RuntimeTransport;
    steer: RuntimeSteerMode;
    resume: boolean;
    tools: boolean;
    toolOutput: boolean;
    approvals: boolean;
    questions: boolean;
    images: boolean;
    subagents: boolean;
}
export interface RuntimeEventIdentity {
    version: 1;
    runId: string;
    /** Durable jaw chat identity, not a provider's native session identifier. */
    sessionId: string;
    /** Routing scope may differ from the chat session (e.g. mention-watch). */
    scope: string;
    turnId: string;
    /** Allocated by committed trace storage; monotonic, not contiguous. */
    seq: number;
    parentItemId?: string;
}
export interface RuntimeRequestView {
    title: string;
    fields: Array<{ id: string; label: string; options: Array<{ id: string; label: string }>; multiSelect: boolean; allowFreeform: boolean }>;
}
export type RuntimeEvent = RuntimeEventIdentity & (
    | { kind: 'turn-start'; provider: string }
    | { kind: 'message'; itemId: string; phase: RuntimePhase; text: string; operation: 'append' | 'replace' }
    | { kind: 'reasoning'; itemId: string; text: string; operation: 'append' | 'replace' }
    | { kind: 'tool'; itemId: string; name: string; status: RuntimeItemStatus; input?: string; output?: string; detail?: string }
    | { kind: 'request'; requestId: string; requestType: 'approval' | 'question'; view: RuntimeRequestView }
    | { kind: 'request-settled'; requestId: string }
    | { kind: 'usage'; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
    | { kind: 'turn-end'; status: Exclude<RuntimeItemStatus, 'running'>; finalText: string | null; error?: string }
);
type EventBody<T> = T extends RuntimeEventIdentity ? Omit<T, keyof RuntimeEventIdentity> : never;
export type RuntimeEventBody = EventBody<RuntimeEvent>;
