import type { CodeSessionReplayEvent } from './code-session-client';
import { assistantChunkMergeAction, messageIdFromCodeChunk } from './code-event-dedupe';
import { findLastToolMessageIndex, normalizeToolContentFromUpdate, type TranscriptEntry } from './code-types';

export function normalizeToolStatus(status: string): 'running' | 'done' | 'failed' {
    const value = status.toLowerCase();
    if (value === 'failed' || value === 'error' || value === 'errored') return 'failed';
    if (value === 'completed' || value === 'done' || value === 'success') return 'done';
    return 'running';
}

export function replayEventsToTranscriptEntries(events: CodeSessionReplayEvent[]): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const event of events) {
        const update = event.update ?? {};
        if (event.event === 'code_user_message_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            const messageId = messageIdFromCodeChunk(update);
            if (text) entries.push({ role: 'user', text, ...(messageId ? { messageId } : {}) });
        } else if (event.event === 'code_agent_message_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) continue;
            const messageId = messageIdFromCodeChunk(update);
            const last = entries[entries.length - 1];
            if (last?.role === 'assistant') {
                const mergeAction = assistantChunkMergeAction(last.text, text);
                if (last.messageId && messageId && last.messageId !== messageId) {
                    if (mergeAction === 'replace') {
                        last.text = text;
                        last.messageId = messageId;
                        continue;
                    }
                    entries.push({ role: 'assistant', text, messageId });
                    continue;
                }
                if (mergeAction === 'drop') continue;
                last.text = mergeAction === 'replace' ? text : last.text + text;
                if (messageId && !last.messageId) last.messageId = messageId;
            } else {
                entries.push({ role: 'assistant', text, ...(messageId ? { messageId } : {}) });
            }
        } else if (event.event === 'code_agent_thought_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) continue;
            const messageId = messageIdFromCodeChunk(update);
            const last = entries[entries.length - 1];
            if (last?.role === 'thinking' && (!last.messageId || !messageId || last.messageId === messageId)) {
                last.text += text;
                if (messageId && !last.messageId) last.messageId = messageId;
            }
            else entries.push({ role: 'thinking', text, ...(messageId ? { messageId } : {}) });
        } else if (event.event === 'code_tool_call') {
            const title = String(update['title'] ?? update['toolName'] ?? 'tool');
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? 'pending');
            const content = normalizeToolContentFromUpdate(update);
            entries.push({ role: 'tool', text: title, toolName: title, toolCallId, toolContent: content, toolStatus: normalizeToolStatus(status) });
        } else if (event.event === 'code_tool_call_update') {
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? '');
            const content = normalizeToolContentFromUpdate(update);
            const idx = findLastToolMessageIndex(entries, toolCallId);
            if (idx < 0) continue;
            const entry = { ...entries[idx] };
            if (status) entry.toolStatus = normalizeToolStatus(status);
            if (content.length > 0) entry.toolContent = content;
            entries[idx] = entry;
        }
    }
    return entries;
}
