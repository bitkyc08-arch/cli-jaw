/** Public Code contracts. Native runtime identities never belong on this wire. */
export type CodeProviderId = 'codex-app' | 'claude' | 'cursor' | 'grok';
export type CodePermissionMode = 'ask' | 'auto' | 'read-only';
export type CodeSessionStatus = 'idle' | 'starting' | 'streaming' | 'stopping' | 'suspended' | 'failed';

export interface CodeCapabilities {
    resume: boolean;
    interrupt: boolean;
    permissions: boolean;
    setModelMidSession: boolean;
    efforts: string[];
    permissionModes: CodePermissionMode[];
}

export interface CodeSessionError {
    code: string;
    message: string;
    at: number;
    recoverable: boolean;
}

export interface CodeSessionInfo {
    sessionId: string;
    provider: CodeProviderId;
    cwd: string;
    title: string | null;
    model: string;
    effort: string | null;
    permissionMode: CodePermissionMode;
    status: CodeSessionStatus;
    turnId: string | null;
    archivedAt: number | null;
    error: CodeSessionError | null;
    resume: { available: boolean; reason: string | null };
    capabilities: CodeCapabilities;
    epoch: number;
    sequence: number;
    revision: number;
    createdAt: number;
    lastUsedAt: number;
    /** Current index/snapshot attention, absent when not hydrated. */
    pendingPermissionCount?: number;
}

export interface CodePermissionRequest {
    permissionId: string;
    sessionId: string;
    turnId: string;
    epoch: number;
    title: string;
    detail: string;
    options: Array<{ optionId: string; label: string; kind: string }>;
    requestedAt: number;
}

export type CodeItemKind = 'user_message' | 'assistant_message' | 'reasoning'
    | 'tool_call' | 'file_change' | 'permission_request' | 'turn_started'
    | 'turn_completed' | 'turn_failed' | 'turn_cancelled' | 'session_runtime' | 'notice';

export interface CodeItem {
    itemId: string;
    /** Store-owned first appearance order, unchanged by later updates. */
    firstSequence?: number;
    turnId: string | null;
    kind: CodeItemKind;
    status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
    phase?: 'commentary' | 'final' | 'unknown';
    text?: string;
    clientTurnKey?: string;
    tool?: { name: string; input?: string; detail?: string; output?: string };
    permission?: CodePermissionRequest;
    truncation?: { storedChars: number; sourceChars: number; reason: string };
    parentItemId?: string;
    createdAt: number;
    updatedAt: number;
}

export interface CodeWireEvent {
    topic: 'code';
    event: 'code_item' | 'code_item_update' | 'code_session';
    sessionId: string;
    sequence: number;
    epoch: number;
    item?: CodeItem;
    update?: CodeItemUpdate;
    session?: CodeSessionInfo;
}

/** Sequence-ordered compact update; snapshots always contain complete items. */
export interface CodeItemUpdate {
    itemId: string;
    turnId: string | null;
    firstSequence: number;
    updatedAt: number;
    appendText?: string;
    appendToolOutput?: string;
    status?: CodeItem['status'];
    phase?: CodeItem['phase'];
}

export interface CodeSnapshot {
    session: CodeSessionInfo;
    items: CodeItem[];
    sequence: number;
    pendingPermissions: CodePermissionRequest[];
    truncated: boolean;
}

export interface CodePromptReceipt {
    turnId: string;
    clientTurnKey: string;
    sequence: number;
    status: 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed';
}

export interface CodeEventsPage {
    events: CodeWireEvent[];
    nextSequence: number;
    throughSequence: number;
    hasMore: boolean;
}

export interface CodeHistoryPage {
    items: CodeItem[];
    beforeSequence: number | null;
    hasMore: boolean;
    sequence: number;
}

export interface CodeSessionPage {
    sessions: CodeSessionInfo[];
    limit: number;
    offset: number;
    hasMore: boolean;
}

export interface CodeCreateSessionRequest {
    provider: CodeProviderId;
    cwd: string;
    model: string;
    effort: string | null;
    permissionMode: CodePermissionMode;
}

export interface CodePatchSessionRequest {
    expectedRevision: number;
    title?: string | null;
    model?: string;
    effort?: string | null;
    permissionMode?: CodePermissionMode;
    archived?: boolean;
}

export interface CodePromptRequest { text: string; clientTurnKey: string }
export interface CodeCancelRequest { turnId: string; epoch: number }
export interface CodePermissionAnswer {
    sessionId: string;
    turnId: string;
    epoch: number;
    optionId: string;
}

export interface CodeProviderCatalog {
    id: CodeProviderId;
    label: string;
    available: boolean;
    reason: string | null;
    models: string[];
    defaultModel: string;
    defaultEffort: string | null;
    capabilities: CodeCapabilities;
    modelSource: 'registry' | 'cache' | 'native';
}

export interface CodeModelCatalog {
    providers: CodeProviderCatalog[];
    defaultProvider: CodeProviderId;
}
