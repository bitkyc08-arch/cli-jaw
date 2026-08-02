// ─── Slack Event Normalization ───────────────────────
// Pure decision + extraction helpers. No IO, so every gating rule below is
// directly unit-testable without a socket or a workspace.

export type SlackMessageEvent = {
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    blocks?: unknown[];
    files?: Array<{ id?: string; name?: string; url_private?: string; size?: number }>;
};

export type SlackGateConfig = {
    selfUserId: string | null;
    allowBots: boolean;
    mentionOnly: boolean;
    channelIds: string[];
};

export type SlackGateDecision =
    | { process: true }
    | { process: false; reason: string };

/** Message subtypes that are edits/joins/system noise, never user input. */
const IGNORED_SUBTYPES = new Set([
    'message_changed',
    'message_deleted',
    'channel_join',
    'channel_leave',
    'channel_topic',
    'channel_purpose',
    'bot_message',
    'thread_broadcast_deleted',
]);

export function isDirectMessage(event: SlackMessageEvent): boolean {
    return event.channel_type === 'im' || (event.channel || '').toUpperCase().startsWith('D');
}

export function mentionsUser(text: string, userId: string): boolean {
    return new RegExp(`<@${userId}(?:\\|[^>]*)?>`).test(text);
}

export function stripMention(text: string, userId: string): string {
    return text.replace(new RegExp(`<@${userId}(?:\\|[^>]*)?>`, 'g'), '').trim();
}

/**
 * Allowlist/DM policy, shared by BOTH the message path and the slash-command
 * path. A slash command that skipped this check would be an allowlist bypass:
 * any user in any channel could invoke orchestration.
 */
export function isConversationAllowed(
    conversationId: string,
    channelIds: string[],
    isDm: boolean,
): boolean {
    if (isDm) return true;
    if (!channelIds.length) return true;
    return channelIds.includes(conversationId);
}

export function shouldProcessSlackEvent(
    event: SlackMessageEvent,
    config: SlackGateConfig,
    envelopeType: string,
): SlackGateDecision {
    if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) {
        return { process: false, reason: `subtype_${event.subtype}` };
    }
    // Self-echo: our own posts arrive back as message events. Without this the
    // bot answers itself forever.
    if (config.selfUserId && event.user === config.selfUserId) {
        return { process: false, reason: 'self_message' };
    }
    if (event.bot_id && !config.allowBots) {
        return { process: false, reason: 'bot_message' };
    }
    if (!event.channel) {
        return { process: false, reason: 'missing_channel' };
    }

    const dm = isDirectMessage(event);
    if (!isConversationAllowed(event.channel, config.channelIds, dm)) {
        return { process: false, reason: 'channel_not_allowed' };
    }
    // app_mention envelopes are mentions by definition; message events in a
    // channel need the gate. DMs always bypass it.
    if (config.mentionOnly && !dm && event.type !== 'app_mention') {
        if (!config.selfUserId || !mentionsUser(event.text || '', config.selfUserId)) {
            return { process: false, reason: 'mention_required' };
        }
    }
    if (envelopeType === 'events_api' && !event.text && !event.blocks?.length && !event.files?.length) {
        return { process: false, reason: 'empty_event' };
    }
    return { process: true };
}

/**
 * Extract readable text from Block Kit blocks.
 * Slack messages forwarded from apps often have an empty `text` with all the
 * content in `blocks`; without this the agent receives an empty prompt.
 */
export function extractTextFromBlocks(blocks: unknown[], maxChars = 6000): string {
    const out: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return; // guard against cyclic payloads
        seen.add(node);
        const obj = node as Record<string, unknown>;
        if (typeof obj['text'] === 'string') out.push(obj['text']);
        else if (obj['text']) walk(obj['text']);
        for (const key of ['elements', 'fields', 'blocks']) {
            const value = obj[key];
            if (Array.isArray(value)) value.forEach(walk);
        }
    };
    blocks.forEach(walk);
    return out.join('\n').slice(0, maxChars).trim();
}

/** The prompt text an agent should receive for this event. */
export function resolveEventText(event: SlackMessageEvent, selfUserId: string | null): string {
    let text = (event.text || '').trim();
    if (!text && event.blocks?.length) text = extractTextFromBlocks(event.blocks);
    if (selfUserId) text = stripMention(text, selfUserId);
    return text.trim();
}
