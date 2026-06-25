export type WebAiVendor = 'chatgpt' | 'gemini' | 'grok';
export type WebAiStatus = 'ready' | 'rendered' | 'sent' | 'streaming' | 'complete' | 'blocked' | 'timeout' | 'error' | 'interstitial';
export type WebAiNotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';
/**
 * ChatGPT supports the `upload` runtime after PRD32.7-B. Gemini upload remains
 * fail-closed until a Gemini-specific frontend capability schema and runtime
 * adapter exist.
 */
export type AttachmentPolicy = 'inline-only' | 'upload' | 'auto';

export interface QuestionEnvelope {
    vendor: WebAiVendor;
    system?: string;
    prompt: string;
    project?: string;
    goal?: string;
    context?: string;
    question?: string;
    output?: string;
    constraints?: string;
    attachmentPolicy: AttachmentPolicy;
}

export interface QuestionEnvelopeInput {
    vendor?: string;
    url?: string;
    system?: string;
    prompt?: string;
    project?: string;
    goal?: string;
    context?: string;
    question?: string;
    output?: string;
    constraints?: string;
    attachmentPolicy?: string;
    filePath?: string;
    filePaths?: string[];
    thinkingTime?: string;
    model?: string;
    reasoningEffort?: string;
    contextFromFiles?: string[];
    contextExclude?: string[];
    contextFile?: string;
    maxInput?: string | number;
    maxFileSize?: string | number;
    filesReport?: boolean;
    contextTransport?: 'inline' | 'upload' | 'auto' | 'none';
    inlineOnly?: boolean;
    /** Explicit opt-in for provider Copy button capture; does not read the OS clipboard. */
    allowCopyMarkdownFallback?: boolean;
    allowGrokContextPack?: boolean;
    reuseTab?: boolean;
    newTab?: boolean;
    requireSourceAudit?: boolean;
    sourceAuditRatio?: string | number;
    sourceAuditScope?: string;
    sourceAuditDate?: string;
    tools?: string[];
    autoTools?: boolean;
    research?: string;
    followUps?: string[];
}

export interface RenderedQuestionBundle {
    markdown: string;
    composerText: string;
    estimatedChars: number;
    warnings: string[];
}

export interface CommittedTurnBaseline {
    vendor: WebAiVendor;
    targetId: string;
    url: string;
    promptHash: string;
    assistantCount: number;
    committedTurnCount?: number;
    textHash?: string;
    capturedAt: string;
}

export type WebAiSessionStatus = 'sent' | 'streaming' | 'complete' | 'timeout' | 'error';

export interface WebAiSessionTabState {
    createdAt: string;
    lastActiveAt: string;
    recoveryCount: number;
    closeCount: number;
}

export interface WebAiTurnRecord {
    index: number;
    prompt: string;
    answer: string | null;
    status: 'complete' | 'failed';
    warnings: string[];
    sentAt: string;
    completedAt: string | null;
}

export interface WebAiSessionRecord {
    vendor: WebAiVendor;
    sessionId: string;
    targetId: string;
    tabId?: string;
    url: string;
    conversationUrl?: string;
    promptHash: string;
    assistantCount: number;
    committedTurnCount?: number;
    status: WebAiSessionStatus;
    timeoutMs: number;
    notifyOnComplete?: boolean;
    capabilityMode?: string;
    answerText?: string;
    answerArtifact?: import('./answer-artifact.js').AnswerArtifact;
    sourceAudit?: import('./source-audit.js').SourceAuditResult;
    lastSeenTextHash?: string;
    tabState?: WebAiSessionTabState;
    turns?: WebAiTurnRecord[];
    followUpCount?: number;
    completedAt?: string;
    failedAt?: string;
    staleAt?: string;
    lastError?: string;
    trace?: Array<Record<string, unknown>>;
    createdAt: string;
    updatedAt: string;
}

export interface WebAiNotificationEvent {
    eventId: string;
    type: 'web-ai.answer.completed' | 'web-ai.answer.failed' | 'web-ai.session.stale' | 'web-ai.capability.unsupported' | 'web-ai.provider.login-required';
    vendor: WebAiVendor;
    sessionId: string;
    url?: string;
    conversationUrl?: string;
    status: WebAiNotificationStatus;
    answerExcerpt?: string;
    answerHash?: string;
    capabilityMode?: string;
    elapsedMs?: number;
    reason?: string;
    createdAt: string;
    deliveredAt?: string;
    error?: string;
}

export interface WebAiOutput {
    ok: boolean;
    vendor: WebAiVendor;
    status: WebAiStatus;
    url?: string;
    answerText?: string;
    answerArtifact?: import('./answer-artifact.js').AnswerArtifact;
    sourceAudit?: import('./source-audit.js').SourceAuditResult;
    rendered?: RenderedQuestionBundle;
    baseline?: CommittedTurnBaseline;
    sessionId?: string;
    sessions?: WebAiSessionRecord[];
    notifications?: WebAiNotificationEvent[];
    watchers?: Array<{
        sessionId: string;
        vendor: WebAiVendor;
        startedAt: string;
        deadlineAt: string;
        status: 'running' | 'complete' | 'timeout' | 'error';
    }>;
    next?: 'poll' | 'reattach' | 'stop';
    canvas?: { kind: 'opened'; reason?: string };
    traceSummary?: import('./action-trace.js').TraceSummary;
    contextPack?: import('./context-pack/index.js').ContextPackSummary;
    usedFallbacks?: string[];
    warnings: string[];
    error?: string;
    interstitial?: import('./interstitial.js').InterstitialResult;
}
