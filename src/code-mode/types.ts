// Code mode shared types (Phase 1 scaffold — design SoT: jawcode devlog 112.3/112.4).
// Transport abstraction per D112-1: UI/routes depend on CodeSessionTransport only,
// so the ACP-stdio implementation can be swapped for in-process later with zero UI change.

export interface CodeSettings {
    maxConcurrentSessions: number;
    idleReapMs: number;
}

/** Single source of truth for code-mode defaults (also seeded in core/config.ts). */
export const DEFAULT_CODE_SETTINGS: CodeSettings = {
    maxConcurrentSessions: 4,
    idleReapMs: 30_000,
};

export type CodeSessionStatus = 'starting' | 'idle' | 'streaming' | 'closed';

export interface CodeSessionInfo {
    sessionId: string;
    cwd: string;
    status: CodeSessionStatus;
    createdAt: number;
    lastUsedAt: number;
    title?: string;
    replayEvents?: CodeSessionReplayEvent[];
}

export interface CodeSessionReplayEvent {
    event: string;
    sessionId: string;
    update: Record<string, unknown>;
}

export interface StoredCodeSessionInfo {
    sessionId: string;
    cwd: string;
    title?: string;
    firstMessage?: string;
    updatedAt?: string;
    lastModified?: number;
    messageCount?: number;
    size?: number;
}

/** Permission request relayed from the engine; answered via REST. */
export interface PendingPermission {
    permissionId: string;
    sessionId: string;
    /** ACP ToolCallUpdate payload (opaque to the host; rendered by the UI). */
    toolCall: Record<string, unknown>;
    /** ACP PermissionOption[] — { optionId, name, kind }. */
    options: Array<Record<string, unknown>>;
    requestedAt: number;
}

export interface PromptAccepted {
    accepted: true;
    sessionId: string;
}

export interface CodeSessionTransport {
    /** Spawn/ensure the engine and create a session rooted at an absolute cwd. */
    newSession(cwd: string, opts?: { model?: string }): Promise<CodeSessionInfo>;
    loadSession(sessionId: string, cwd: string): Promise<CodeSessionInfo>;
    listStoredSessions(cwd?: string): Promise<StoredCodeSessionInfo[]>;
    extMethod(sessionId: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    forkSession(sessionId: string, cwd: string): Promise<CodeSessionInfo>;
    setSessionModel(sessionId: string, modelId: string): Promise<void>;
    /** Fire a prompt turn. Resolves on acceptance; streaming arrives via the 'jwc' bus topic (202+poll contract, 113.2 §4). */
    prompt(sessionId: string, text: string): Promise<PromptAccepted>;
    cancel(sessionId: string): Promise<void>;
    setSessionConfig(sessionId: string, configId: string, valueId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    listSessions(): CodeSessionInfo[];
    listPendingPermissions(sessionId?: string): PendingPermission[];
    /** Answer a pending permission. optionId null = cancelled outcome. Returns false if unknown id. */
    answerPermission(permissionId: string, optionId: string | null): boolean;
    dispose(): Promise<void>;
}
