// ─── Inbound Envelope Normalizers ────────────────────
// One pure function per vendor, turning a vendor inbound event into an
// `InboundEnvelope`. Nothing here reaches a network, a clock it was not handed,
// or a vendor SDK: the transport handler collects the fields it already has and
// calls in.
//
// Deliberately NOT importing `src/telegram/bot.ts`, `src/slack/bot.ts` or
// `src/discord/bot.ts`. Those modules run at import time (bot singletons, dedupe
// stores, prepared SQLite statements) and drag in the vendor SDKs — discord.js
// alone costs ~48MB RSS. A normalizer that cannot be imported without starting a
// transport is not testable, so the inputs are narrow structural types declared
// locally instead.
//
// Every function returns `null` when a required field cannot be determined. The
// caller treats null as "do not admit this event". Fabricating a placeholder
// (`'unknown'`, `0`, `''`) would be worse than dropping: `accountId` namespaces
// the ingress journal, so a fake one silently merges two workspaces' event keys.

import type { InboundEnvelope, RemoteTarget } from './types.js';

/** Injectable clock. Tests pass a fixed function; production takes the default. */
export type NowFn = () => number;

/** Build the opaque correlation handle for logs and traces.
 *
 *  It exists to join a core-side log line back to a vendor delivery when
 *  debugging, and that is ALL it may carry. Never put a token, a message body, a
 *  file name or an attachment URL in here: this string is written to logs and
 *  traces that are not redacted downstream and are routinely pasted into issues.
 *  Vendor ids are safe because they are meaningless without the credential. */
const rawRef = (kind: string, id: string): string => `${kind}:${id}`;

// ─── Telegram ────────────────────────────────────────

export type TelegramInboundInput = {
    /** From `getMe` at startup. Null until it returns, and the transport refuses
     *  to start without it, so a null here is a contract violation → drop. */
    botUserId: number | string | null | undefined;
    updateId: number | string | null | undefined;
    chatId: number | string | null | undefined;
    fromId: number | string | null | undefined;
    /** Telegram forum topics. `message_thread_id` is only meaningful when the
     *  message is flagged as a topic message (mirrors `buildTelegramTarget`). */
    isTopicMessage?: boolean;
    messageThreadId?: number | string | null | undefined;
    target: RemoteTarget;
    now?: NowFn;
};

/**
 * Telegram: `receivedAt` comes from the adapter clock, not the update.
 *
 * A Telegram update does carry `message.date`, but this tree never extracts it —
 * no handler reads it and no existing field is derived from it. It is also a SEND
 * time in whole seconds, not a receive time, and it is absent on several update
 * kinds this path admits. Deriving `receivedAt` from it would silently change
 * meaning per update type, so the honest value is the moment this process
 * observed the update. The clock is injectable purely so tests are deterministic.
 */
export function telegramInboundEnvelope(input: TelegramInboundInput): InboundEnvelope | null {
    const accountId = idString(input.botUserId);
    const eventId = idString(input.updateId);
    const chatId = idString(input.chatId);
    const actorId = idString(input.fromId);
    if (!accountId || !eventId || !chatId || !actorId) return null;
    if (input.target.channel !== 'telegram') return null;

    const threadKey = telegramThreadKey(input);
    return {
        channel: 'telegram',
        accountId,
        eventId,
        conversationKey: `telegram:${chatId}`,
        ...(threadKey ? { threadKey } : {}),
        actorId,
        receivedAt: (input.now ?? Date.now)(),
        // Telegram's polling offset only advances once the reply is delivered, so a
        // crash mid-run redelivers the update. A transport property, not a setting.
        ackPolicy: 'after-final-delivery',
        rawEnvelopeRef: rawRef('telegram:update', eventId),
        target: input.target,
    };
}

/** Topic id 1 is the forum's General topic, which is the chat itself rather than a
 *  distinct thread. `buildTelegramTarget` excludes it from `threadId`; excluding it
 *  here too keeps `threadKey` and `target.threadId` from disagreeing. */
function telegramThreadKey(input: TelegramInboundInput): string | undefined {
    if (!input.isTopicMessage) return undefined;
    const raw = input.messageThreadId;
    if (raw == null) return undefined;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 1) return undefined;
    return String(raw);
}

// ─── Slack ───────────────────────────────────────────

export type SlackInboundInput = {
    /** `settings.slack.teamId`, or the `team_id` learned from `auth.test`. */
    teamId: string | null | undefined;
    channelId: string | null | undefined;
    /** The message's own ts. Also the Slack event's time source. */
    ts: string | null | undefined;
    /** Parent ts when this message arrived inside a thread. */
    threadTs?: string | null | undefined;
    /** `event.user`, or `event.bot_id` for a bot-authored message. */
    userId?: string | null | undefined;
    botId?: string | null | undefined;
    /** Socket Mode envelope id, for correlation only. */
    envelopeId?: string | null | undefined;
    /** `settings.slack.replyInThread !== false`. When false the runtime replies at
     *  conversation top level, so a top-level message opens no thread. */
    replyInThread?: boolean;
    target: RemoteTarget;
};

/**
 * Slack: `receivedAt` is derived from `event.ts`, which unlike the other two
 * vendors IS a canonical event time (epoch seconds with microsecond fraction).
 * An unparseable ts drops the event rather than falling back to the local clock —
 * `ts` is also the event identity, so a ts we cannot read means we cannot dedupe.
 */
export function slackInboundEnvelope(input: SlackInboundInput): InboundEnvelope | null {
    const accountId = (input.teamId ?? '').trim();
    const channelId = (input.channelId ?? '').trim();
    const ts = (input.ts ?? '').trim();
    const actorId = (input.userId ?? '').trim() || (input.botId ?? '').trim();
    if (!accountId || !channelId || !ts || !actorId) return null;
    if (input.target.channel !== 'slack') return null;

    const receivedAt = Number(ts) * 1000;
    if (!Number.isFinite(receivedAt)) return null;

    // Same shape as `slackEventKey` in src/slack/ingress.ts, the source of truth for
    // the ingress dedupe key. Reimplemented rather than imported because that module
    // opens the SQLite dedupe store at import time. Its `'unknown'` team fallback is
    // unreachable from here: an empty team already returned null.
    const eventId = `${accountId}:${channelId}:${ts}`;
    const threadTs = (input.threadTs ?? '').trim();
    // The PARENT ts identifies the thread. A top-level message has none, so its own
    // ts becomes the parent of the thread a reply would open (see
    // `resolveSlackThreadTs`). With replyInThread off no thread is opened at all.
    const threadKey = threadTs || (input.replyInThread !== false ? ts : '');
    const envelopeId = (input.envelopeId ?? '').trim();

    return {
        channel: 'slack',
        accountId,
        eventId,
        conversationKey: `slack:${accountId}:${channelId}`,
        ...(threadKey ? { threadKey } : {}),
        actorId,
        receivedAt,
        // Socket Mode requires an ack within 3s, before any work starts.
        ackPolicy: 'transport-first',
        ...(envelopeId ? { rawEnvelopeRef: rawRef('slack:envelope', envelopeId) } : {}),
        target: input.target,
    };
}

// ─── Discord ─────────────────────────────────────────

export type DiscordInboundInput = {
    /** `client.user.id`, read at HANDLER time. The gateway may reconnect as a
     *  different session, and `client.user` is null before READY, so capturing it
     *  once at startup would pin a stale or empty identity. */
    botUserId: string | null | undefined;
    messageId: string | null | undefined;
    channelId: string | null | undefined;
    authorId: string | null | undefined;
    guildId?: string | null | undefined;
    /** `msg.channel.isThread()`. */
    isThread?: boolean;
    /** Parent channel of a thread. */
    parentId?: string | null | undefined;
    target: RemoteTarget;
    now?: NowFn;
};

/**
 * Discord: `receivedAt` comes from the adapter clock for the same reason as
 * Telegram. discord.js exposes `msg.createdTimestamp`, but this tree extracts it
 * nowhere, and it is derived from the snowflake's CREATION time — for an edited or
 * gateway-replayed message that can sit far from when we received it. Rather than
 * guess which one the ingress journal means, record when we observed it.
 */
export function discordInboundEnvelope(input: DiscordInboundInput): InboundEnvelope | null {
    const accountId = (input.botUserId ?? '').trim();
    const eventId = (input.messageId ?? '').trim();
    const channelId = (input.channelId ?? '').trim();
    const actorId = (input.authorId ?? '').trim();
    if (!accountId || !eventId || !channelId || !actorId) return null;
    if (input.target.channel !== 'discord') return null;

    // A DM has no guild. 'dm' occupies the guild slot so a DM conversation key can
    // never collide with a guild id, and stays readable in a log line.
    const guildId = (input.guildId ?? '').trim() || 'dm';
    // In a thread the channel id IS the thread id, so the parent channel identifies
    // the conversation (mirrors `buildDiscordTarget`).
    const parentId = (input.parentId ?? '').trim();
    const conversationId = input.isThread ? (parentId || channelId) : channelId;

    return {
        channel: 'discord',
        accountId,
        eventId,
        conversationKey: `discord:${guildId}:${conversationId}`,
        ...(input.isThread ? { threadKey: channelId } : {}),
        actorId,
        receivedAt: (input.now ?? Date.now)(),
        // The gateway acks on its own schedule, outside this process's control.
        ackPolicy: 'transport-managed',
        rawEnvelopeRef: rawRef('discord:message', eventId),
        target: input.target,
    };
}

/** Telegram ids arrive as numbers on the wire and as strings everywhere in this
 *  tree. Rejects the empty string and non-finite numbers so a bad id drops the
 *  event instead of producing `'NaN'` or `'undefined'` as a key fragment. */
function idString(value: number | string | null | undefined): string | null {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
