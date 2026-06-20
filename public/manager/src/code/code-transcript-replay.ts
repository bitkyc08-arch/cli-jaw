import type { CodeSessionReplayEvent } from './code-session-client';
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
            if (text) entries.push({ role: 'user', text });
        } else if (event.event === 'code_agent_message_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) continue;
            const last = entries[entries.length - 1];
            if (last?.role === 'assistant') last.text += text;
            else entries.push({ role: 'assistant', text });
        } else if (event.event === 'code_agent_thought_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) continue;
            const last = entries[entries.length - 1];
            if (last?.role === 'thinking') last.text += text;
            else entries.push({ role: 'thinking', text });
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
