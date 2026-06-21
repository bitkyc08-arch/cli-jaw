import type { CodeSessionReplayEvent } from './code-session-client';
import type { CodeEvent } from './useCodeEvents';

type ChunkLikeEvent = Pick<CodeEvent, 'event' | 'sessionId' | 'update' | 'sseEventId'>;
export type AssistantChunkMergeAction = 'append' | 'drop' | 'replace';

const CHUNK_EVENTS = new Set([
    'code_user_message_chunk',
    'code_agent_message_chunk',
    'code_agent_thought_chunk',
]);

export function textFromCodeChunk(update: Record<string, unknown> | undefined): string {
    const content = update?.['content'] as { type?: string; text?: string } | undefined;
    return String(content?.text ?? update?.['text'] ?? '');
}

export function codeChunkEventKey(event: ChunkLikeEvent, text: string): string | null {
    if (!CHUNK_EVENTS.has(event.event) || !text) return null;
    const update = event.update ?? {};
    const messageId = typeof update['messageId'] === 'string' && update['messageId'].trim()
        ? update['messageId'].trim()
        : '';
    const sseEventId = typeof event.sseEventId === 'string' && event.sseEventId.trim()
        ? event.sseEventId.trim()
        : '';
    const stableId = messageId ? `msg:${messageId}` : sseEventId ? `sse:${sseEventId}` : '';
    if (!stableId) return null;
    return `${event.sessionId ?? ''}:${event.event}:${stableId}:${text}`;
}

export function rememberCodeChunkEvents(seen: Set<string>, events: CodeSessionReplayEvent[]): void {
    for (const event of events) {
        const text = textFromCodeChunk(event.update);
        const key = codeChunkEventKey(event, text);
        if (key) seen.add(key);
    }
}

export function shouldDropDuplicateCodeChunk(seen: Set<string>, event: ChunkLikeEvent, text: string): boolean {
    const key = codeChunkEventKey(event, text);
    if (!key) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
}

export function isDuplicateAssistantFinalChunk(lastText: string, incomingText: string): boolean {
    const normalizedLast = lastText.trim();
    const normalizedIncoming = incomingText.trim();
    if (normalizedIncoming.length < 80) return false;
    return normalizedLast === normalizedIncoming;
}

export function assistantChunkMergeAction(currentText: string, incomingText: string): AssistantChunkMergeAction {
    if (!currentText || !incomingText) return 'append';
    if (currentText === incomingText) return 'drop';
    if (incomingText.startsWith(currentText)) return 'replace';
    if (currentText.startsWith(incomingText)) return 'drop';
    return 'append';
}
