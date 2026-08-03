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

/**
 * One bot, one instance. Socket Mode happily opens several connections per
 * app token and Slack round-robins events across them, so two instances
 * sharing tokens each swallow a random slice of the traffic. `attachPort`
 * names the instance that owns the connection; every other instance must
 * not open the socket. Unset = single-instance behavior (attach).
 */
export function shouldAttachSlack(attachPort: unknown, currentPort: unknown): boolean {
    const attach = String(attachPort ?? '').trim();
    if (!attach) return true;
    return attach === String(currentPort ?? '').trim();
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
    // Slack delivers BOTH an app_mention envelope and a message envelope for
    // the same mention when the app subscribes to both (the shipped manifest
    // does). Without this drop, one mention becomes two agent runs within
    // milliseconds and the gateway dedup slams the second with a public
    // "❌ duplicate". The app_mention copy is the canonical path; DMs never
    // produce app_mention envelopes, so they are unaffected.
    if (!dm && event.type !== 'app_mention' && config.selfUserId
        && mentionsUser(event.text || '', config.selfUserId)) {
        return { process: false, reason: 'mention_via_app_mention' };
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
 *
 * Traversal is ITERATIVE: a deeply nested payload would blow the call stack
 * in a recursive walk, and inbound block structures are attacker-influenced.
 */
export function extractTextFromBlocks(blocks: unknown[], maxChars = 6000): string {
    const out: string[] = [];
    const seen = new Set<unknown>();
    const stack: unknown[] = [...blocks];
    let budget = maxChars;
    while (stack.length > 0 && budget > 0) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue; // guard against cyclic payloads
        seen.add(node);
        const obj = node as Record<string, unknown>;
        const text = obj['text'];
        if (typeof text === 'string') {
            out.push(text);
            budget -= text.length;
        } else if (text) {
            stack.push(text);
        }
        for (const key of ['elements', 'fields', 'blocks']) {
            const value = obj[key];
            // Push in reverse so popping preserves document order.
            if (Array.isArray(value)) {
                for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
            }
        }
    }
    return out.join('\n').slice(0, maxChars).trim();
}

/** The prompt text an agent should receive for this event. */
export function resolveEventText(event: SlackMessageEvent, selfUserId: string | null): string {
    let text = (event.text || '').trim();
    if (!text && event.blocks?.length) text = extractTextFromBlocks(event.blocks);
    if (selfUserId) text = stripMention(text, selfUserId);
    return text.trim();
}
