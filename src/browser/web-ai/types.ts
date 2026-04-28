export type WebAiVendor = 'chatgpt' | 'gemini';
export type WebAiStatus = 'ready' | 'rendered' | 'sent' | 'streaming' | 'complete' | 'blocked' | 'timeout' | 'error';
/**
 * `inline-only` is the only executable policy until PRD32.7 Phase B lands.
 * `upload` and `auto` are reserved type literals that allow callers to declare
 * intent without bypassing the fail-closed guard.
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
    system?: string;
    prompt?: string;
    project?: string;
    goal?: string;
    context?: string;
    question?: string;
    output?: string;
    constraints?: string;
    attachmentPolicy?: string;
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

export interface WebAiSessionRecord {
    vendor: WebAiVendor;
    sessionId: string;
    targetId: string;
    url: string;
    conversationUrl?: string;
    promptHash: string;
    assistantCount: number;
    committedTurnCount?: number;
    status: WebAiSessionStatus;
    timeoutMs: number;
    createdAt: string;
    updatedAt: string;
}

export interface WebAiOutput {
    ok: boolean;
    vendor: WebAiVendor;
    status: WebAiStatus;
    url?: string;
    answerText?: string;
    rendered?: RenderedQuestionBundle;
    baseline?: CommittedTurnBaseline;
    sessionId?: string;
    next?: 'poll' | 'reattach' | 'stop';
    canvas?: { kind: 'opened'; reason?: string };
    usedFallbacks?: string[];
    warnings: string[];
    error?: string;
}
