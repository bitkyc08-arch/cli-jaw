export type ToolContent = { type: string; text?: string; diff?: string; [key: string]: unknown };

export type TranscriptEntry = {
    role: 'user' | 'assistant' | 'tool' | 'thinking';
    text: string;
    toolName?: string;
    toolStatus?: string;
    toolCallId?: string;
    toolContent?: ToolContent[];
    toolOutput?: string;
};

export type PendingPermission = {
    permissionId: string;
    toolCall: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
};

export function findLastToolMessageIndex(messages: TranscriptEntry[], toolCallId: string): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role === 'tool' && message.toolCallId === toolCallId) return i;
    }
    return -1;
}

export function toModelId(provider: string, model: string): string {
    return model.includes('/') ? model : `${provider}/${model}`;
}
