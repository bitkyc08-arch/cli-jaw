import type { RemoteTarget } from '../messaging/types.js';

const CONTEXT_VALUE_LIMIT = 200;

function promptContextValue(value: unknown): string {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, CONTEXT_VALUE_LIMIT);
}

/**
 * Put transport identifiers in the per-turn user prompt, where resumed agents
 * can use them without parsing an internal session label or depending on the
 * multi-session setting.
 */
export function prependRemoteConversationContext(prompt: string, target?: RemoteTarget): string {
    if (target?.channel !== 'slack') return prompt;
    const channelId = promptContextValue(target.targetId);
    if (!channelId) return prompt;
    const threadTs = promptContextValue(target.threadId) || 'none';
    return `Current Slack conversation: channel_id=${channelId}; thread_ts=${threadTs}\n${prompt}`;
}
