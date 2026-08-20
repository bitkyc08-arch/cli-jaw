// ─── Slack Event Normalization ───────────────────────
// Pure decision + extraction helpers. No IO, so every gating rule below is
// directly unit-testable without a socket or a workspace.

export type SlackFileEvent = {
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    mode?: string;
    file_access?: string;
    url_private?: string;
    url_private_download?: string;
};

export type SlackBotProfile = {
    id?: string;
    app_id?: string;
    user_id?: string;
    name?: string;
    team_id?: string;
    deleted?: boolean;
};

export type SlackMessageEvent = {
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    /** Modern granular-permission apps identify themselves here. */
    bot_profile?: SlackBotProfile;
    /** Slack says a present `username` overrides the bot's default name. */
    username?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    blocks?: unknown[];
    files?: SlackFileEvent[];
};

export type SlackGateConfig = {
    selfUserId: string | null;
    allowBots: boolean;
    mentionOnly: boolean;
    channelIds: string[];
    /** true = threads also require a mention (multi-bot escape hatch). */
    threadRequireMention: boolean;
    /**
     * How the bot is in this thread, injected so this module stays IO-free.
     * `owned` = the bot's own message parents the thread; `joined` = it was
     * pulled into a conversation already in progress; null = not in it.
     */
    threadParticipation: (channel: string, threadTs: string) => 'owned' | 'joined' | null;
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

/**
 * The allowlist as the gate must read it: trimmed, deduplicated, and never
 * silently widened by a malformed value.
 *
 * An empty list means every conversation, so a non-array — or an array holding
 * non-strings — used to collapse to "allow everything". That is backwards: a
 * value we cannot parse should not hand out MORE access than the one we can.
 * The route rejects such a write, but settings also arrive from the file
 * watcher and from direct runtime patches, and an agent can edit settings.json
 * itself. This is the one place every path passes through (#406).
 *
 * A malformed value is treated as a single unmatchable id, which denies every
 * channel while still letting DMs through — visible immediately, and safe.
 */
export const MALFORMED_SLACK_ALLOWLIST = '\u0000malformed-slack-allowlist';

/**
 * A ceiling on the allowlist. The dedup below is quadratic, and settings reach
 * this reader from the file watcher and direct edits as well as the route, so a
 * bound that lives only in the route does not bind. Measured on this reader:
 * 1k ids ~0.8ms, 10k ~62ms — per event.
 *
 * No Slack workspace allowlists this many conversations on purpose, so a list
 * this long is a mistake, and a mistake must not open access.
 */
export const SLACK_ALLOWLIST_MAX = 1000;

export function readSlackAllowlist(raw: unknown): string[] {
    // `undefined` is absence — the shipped default is an empty list, so nothing
    // was ever configured and every conversation is allowed. `null` is not the
    // same thing: it is a value someone wrote, the route refuses to write it
    // (`invalidSlackChannelIds`), and reading it as "allow everything" is
    // exactly the widening this reader exists to prevent (#406).
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return [MALFORMED_SLACK_ALLOWLIST];
    if (raw.length > SLACK_ALLOWLIST_MAX) return [MALFORMED_SLACK_ALLOWLIST];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') return [MALFORMED_SLACK_ALLOWLIST];
        const id = entry.trim();
        // A padded id matches nothing, so keeping it verbatim would quietly
        // block the channel the operator meant to allow.
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    // A list that named conversations and resolved to none of them is not the
    // empty default. `[""]` would collapse to "every conversation" — a WIDENING
    // from a write the route rejects outright. Dropping blanks beside real ids
    // stays safe because the result still narrows; only an all-blank list has to
    // fail closed (#406).
    if (raw.length > 0 && ids.length === 0) return [MALFORMED_SLACK_ALLOWLIST];
    return ids;
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
    // `bot_id` alone is not the whole bot signal: a granular-permission app can
    // send `bot_profile` without it, and that payload used to walk straight past
    // allowBots:false into an agent run (audit 002 §R2-6).
    if ((event.bot_id || event.bot_profile) && !config.allowBots) {
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
            // Thread continuation, but only for a thread the bot itself started:
            // there, its reply is the parent and every follow-up is addressed to
            // it, so re-mentioning would be noise (Hermes
            // thread_require_mention:false semantics — devlog 260806 unit).
            //
            // A thread the bot was pulled INTO partway does not qualify. People
            // were already talking there and keep talking to each other; reading
            // one mention as consent for the rest of that conversation is how the
            // bot answered six messages that named other people (#400).
            //
            // Ordering is intentional: the self-echo/bot/allowlist gates above
            // already ran, so a participated thread never bypasses those.
            const inParticipatedThread = !config.threadRequireMention
                && !!event.thread_ts
                && config.threadParticipation(event.channel || '', event.thread_ts) === 'owned';
            if (!inParticipatedThread) {
                return { process: false, reason: 'mention_required' };
            }
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
