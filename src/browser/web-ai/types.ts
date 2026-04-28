export type WebAiVendor = 'chatgpt';
export type WebAiStatus = 'ready' | 'rendered' | 'sent' | 'streaming' | 'complete' | 'blocked' | 'timeout' | 'error';
export type AttachmentPolicy = 'inline-only';

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
    textHash?: string;
    capturedAt: string;
}

export interface WebAiOutput {
    ok: boolean;
    vendor: WebAiVendor;
    status: WebAiStatus;
    url?: string;
    answerText?: string;
    rendered?: RenderedQuestionBundle;
    baseline?: CommittedTurnBaseline;
    warnings: string[];
    error?: string;
}
