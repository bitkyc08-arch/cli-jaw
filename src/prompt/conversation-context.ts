import type { RemoteTarget } from '../messaging/types.js';
import { encodeTurnConversation } from '../messaging/turn-conversation.js';
import { stripUndefined } from '../core/strip-undefined.js';

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
    // The same address in the shape /api/channel/send accepts, so an agent that
    // cannot assemble a target has something exact to echo instead of omitting
    // it — omission resolves to whichever conversation spoke last (#474).
    //
    // It rides the PER-TURN prompt rather than the process environment on
    // purpose: `codex-app` leases pooled processes and only sets env at
    // creation, so a reused process would keep answering with the address of
    // the turn that first started it.
    //
    // Built from the SANITIZED ids above, not the raw target: these values reach
    // the prompt, and the line-structure guarantee the sanitizer provides is not
    // something a JSON encoder should be trusted to reproduce.
    const reply = encodeTurnConversation(stripUndefined({
        ...target,
        targetId: channelId,
        threadId: target.threadId ? promptContextValue(target.threadId) : undefined,
        guildId: target.guildId ? promptContextValue(target.guildId) : undefined,
        parentTargetId: target.parentTargetId ? promptContextValue(target.parentTargetId) : undefined,
    }) as RemoteTarget);
    const replyLine = reply ? `; reply_to=${reply}` : '';
    return `Current Slack conversation: channel_id=${channelId}; thread_ts=${threadTs}${replyLine}\n${prompt}`;
}
