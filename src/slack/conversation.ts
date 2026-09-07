// ─── Slack Conversation Context ──────────────────────
// "Which conversation is this, and who is taking part in it?" — the third axis
// beside sender identity (identity.ts) and workspace roster (roster.ts).
//
// The concurrency discipline (TTL caching, failure suppression, capability
// lockout, coalescing, cancellation, generation invalidation) is NOT
// reimplemented here: it lives in enrichment-cache.ts, which identity.ts also
// uses. This module owns only what is specific to Slack conversations — the API
// shapes, participant derivation, and what each failure means.
//


import { slackApi, type SlackFetch } from './api.js';
import { fetchSlackReplies, type SlackHistoryMessage } from './history.js';
import {
    sanitizeIdentityName,
    getCachedSlackIdentities,
} from './identity.js';
import { EnrichmentCache, type Suppression } from './enrichment-cache.js';

export type SlackConversationKind = 'channel' | 'private' | 'dm' | 'group_dm' | 'unknown';

export type SlackConversationInfo = {
    id: string;
    /** Human-readable name. Equals `id` when unresolved. */
    name: string;
    kind: SlackConversationKind;
    /** Untrusted input: sanitized and length-capped before it is ever exposed. */
    topic?: string;
    /**
     * Slack's reported conversation member count. Slack does not document a
     * bot/human split, so this is NOT "how many people" — label it as-is.
     */
    memberCount?: number;
    resolved: boolean;
};

export type SlackThreadParticipant = {
    id: string;
    name: string;
    isBot: boolean;
    /**
     * The `U…` id carried alongside a bot marker, when the message had both.
     *
     * `id` prefers the bot id, but self-detection compares against
     * `auth.test`'s `user_id`, which is a `U…`. Without keeping this the bot's
     * OWN messages render as some third-party app.
     */
    userId?: string;
};

export type SlackThreadInfo = {
    threadTs: string;
    replyCount: number;
    participants: SlackThreadParticipant[];
    /** Parent message text, truncated. */
    parentText?: string;
    /** Raw messages, for the first-entry prefetch. Not used to build the block. */
    messages?: SlackHistoryMessage[];
    resolved: boolean;
};

export type ConversationOpts = {
    teamId: string;
    fetchImpl?: SlackFetch;
    signal?: AbortSignal;
};

const CONVERSATION_TTL_MS = 10 * 60 * 1000;
const THREAD_TTL_MS = 60 * 1000;
const CACHE_CAP = 500;
/** Slack caps display names at 64 code points; a topic is a hint, not a body. */
const TOPIC_MAX = 64;
const PARENT_TEXT_MAX = 300;
/**
 * Retained prefetch text per message. 50 messages x 500 code points bounds a
 * cached thread to ~25k characters; without it, 500 entries x 50 messages x
 * Slack's 40k-character limit is a multi-gigabyte ceiling.
 */
const PREFETCH_TEXT_MAX = 500;
/** Bounded so a long thread cannot dominate the prompt block. */
const MAX_PARTICIPANTS = 12;
export const THREAD_FETCH_LIMIT = 50;
const THREAD_FETCH_MAX_PAGES = 10;
const SUPPRESS_MS = 60 * 1000;
const CAPABILITY_MS = 30 * 60 * 1000;
/**
 * Slack documents conversations.info as Tier 3 (50+/min). One start per 1.2s
 * caps us at 50/min; 1/s would allow 60 and exceed the documented floor.
 */
const MIN_START_INTERVAL_MS = 1200;

/**
 * Errors proving the METHOD is unusable workspace-wide. Everything else —
 * including channel-scoped permission failures — is suppressed per resource: one
 * inaccessible private channel must not blind the bot to every other channel.
 */
const CAPABILITY_ERRORS = new Set([
    'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
    'token_expired', 'token_revoked', 'not_allowed_token_type',
    'team_access_not_granted',
]);

type Part = 'conversation' | 'thread';

/**
 * Per-METHOD start clocks. conversations.info and conversations.replies are
 * separate Tier-3 methods with separate budgets: sharing one clock let a channel
 * lookup consume the slot and starve the thread lookup that immediately follows
 * it on the same message.
 */
const lastStartAt = new Map<string, number>();

const conversationCache = new EnrichmentCache<Part, SlackConversationInfo | SlackThreadInfo, string>({
    partitions: {
        conversation: { ttlMs: () => CONVERSATION_TTL_MS, cap: CACHE_CAP },
        // A snapshot, deliberately: its only consumer is the bounded first-entry
        // prefetch, where "the conversation as it stood on entry" is the point.
        thread: { ttlMs: () => THREAD_TTL_MS, cap: CACHE_CAP },
    },
    suppressionCap: CACHE_CAP,
    classifyFailure: (error, ctx): Suppression => (
        CAPABILITY_ERRORS.has(error)
            ? { kind: 'capability', key: ctx.capabilityKey, ttlMs: CAPABILITY_MS }
            // Unknown and future error codes land here too: bounded, never a
            // workspace-wide lock.
            : { kind: 'resource', key: ctx.resourceKey, ttlMs: SUPPRESS_MS }
    ),
});

/** Token-bucket of one PER METHOD: declines rather than queues, so ingress never waits. */
function admitStartFor(method: string): boolean {
    const now = Date.now();
    const previous = lastStartAt.get(method) ?? 0;
    if (now - previous < MIN_START_INTERVAL_MS) return false;
    lastStartAt.set(method, now);
    return true;
}

/**
 * The top-level channel prefetch (bot.ts) calls conversations.history directly —
 * it wants a raw window, not a cached snapshot — so it borrows this clock rather
 * than bypassing it. A busy channel with an unbound session would otherwise
 * fire one Tier-3 call per message with no pacing at all (#518 r2).
 */
export function admitHistoryStart(): boolean {
    return admitStartFor('conversations.history');
}

/**
 * Capability keys are per method. `conversations.info` answering missing_scope
 * proves nothing about `conversations.replies` — they require different scopes,
 * so one must not lock the other out for 30 minutes.
 */
function capabilityKeyFor(method: string): string {
    return `conversation:capability:${method}`;
}

type RawConversation = {
    id?: string; name?: string;
    is_channel?: boolean; is_group?: boolean; is_im?: boolean;
    is_mpim?: boolean; is_private?: boolean;
    topic?: { value?: string };
    num_members?: number;
};

/**
 * Prefix classification. Deliberately NOT slackPeerKind from slack-target.ts:
 * that is a 3-value delivery classification which folds `U` into direct, while
 * this axis needs the public/private distinction.
 */
function kindFromPrefix(id: string): SlackConversationKind {
    const prefix = (id || '').charAt(0).toUpperCase();
    if (prefix === 'D') return 'dm';
    if (prefix === 'G') return 'group_dm';
    if (prefix === 'C') return 'channel';
    return 'unknown';
}

function kindFromConversation(raw: RawConversation, id: string): SlackConversationKind {
    if (raw.is_im) return 'dm';
    if (raw.is_mpim) return 'group_dm';
    if (raw.is_private) return 'private';
    if (raw.is_channel || raw.is_group) return 'channel';
    return kindFromPrefix(id);
}

function degradedConversation(id: string): SlackConversationInfo {
    return { id, name: id, kind: kindFromPrefix(id), resolved: false };
}

function cap(text: string, max: number): string {
    const points = [...text];
    return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * Conversation metadata. Never throws: any failure degrades to the raw id, and
 * the suppression window keeps a broken channel from being re-requested per
 * message.
 */
export async function resolveConversationInfo(
    token: string, channel: string, opts: ConversationOpts,
): Promise<SlackConversationInfo> {
    if (!token || !channel) return degradedConversation(channel);
    const key = `${opts.teamId || 'unknown'}:${channel}`;
    const value = await conversationCache.resolve({
        partition: 'conversation',
        resourceKey: key,
        capabilityKey: capabilityKeyFor('conversations.info'),
        ...(opts.signal ? { signal: opts.signal } : {}),
        admitStart: () => admitStartFor('conversations.info'),
        degraded: () => degradedConversation(channel),
        load: async () => {
            const result = await slackApi<{ channel?: RawConversation }>(
                token, 'conversations.info',
                { channel, include_num_members: true },
                {
                    form: true,
                    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
                    ...(opts.signal ? { signal: opts.signal } : {}),
                },
            );
            const raw = result.data?.channel;
            if (!result.ok || !raw) {
                return { ok: false as const, error: result.error || 'unknown_error' };
            }
            const info: SlackConversationInfo = {
                id: raw.id || channel,
                name: raw.name ? sanitizeIdentityName(raw.name, channel) : channel,
                kind: kindFromConversation(raw, channel),
                resolved: true,
            };
            const topic = raw.topic?.value?.trim();
            // Sanitized like a display name: a topic can carry newlines and
            // control characters that would otherwise forge a prompt line.
            if (topic) info.topic = cap(sanitizeIdentityName(topic, ''), TOPIC_MAX);
            if (typeof raw.num_members === 'number') info.memberCount = raw.num_members;
            return { ok: true as const, value: info };
        },
    });
    return value as SlackConversationInfo;
}

function degradedThread(threadTs: string): SlackThreadInfo {
    return { threadTs, replyCount: 0, participants: [], resolved: false };
}

/**
 * Thread participants and prior messages.
 *
 * Participants are derived from the message AUTHORS, never from `reply_users`:
 * Slack's own reference warns that field "sometimes contains bot IDs rather than
 * user IDs". Bot markers win over `user`, because a modern granular-permission
 * app message carries both.
 */
export async function resolveThreadInfo(
    token: string, channel: string, threadTs: string, opts: ConversationOpts,
): Promise<SlackThreadInfo> {
    if (!token || !channel || !threadTs) return degradedThread(threadTs);
    const key = `${opts.teamId || 'unknown'}:${channel}:${threadTs}`;
    const value = await conversationCache.resolve({
        partition: 'thread',
        resourceKey: key,
        capabilityKey: capabilityKeyFor('conversations.replies'),
        ...(opts.signal ? { signal: opts.signal } : {}),
        admitStart: () => admitStartFor('conversations.replies'),
        degraded: () => degradedThread(threadTs),
        load: async () => {
            let cursor: string | undefined;
            let parent: SlackHistoryMessage | undefined;
            let fetchedReplyCount = 0;
            const newestReplies: SlackHistoryMessage[] = [];
            for (let page = 0; page < THREAD_FETCH_MAX_PAGES; page += 1) {
                const result = await fetchSlackReplies(token, channel, threadTs, {
                    limit: THREAD_FETCH_LIMIT,
                    ...(cursor ? { cursor } : {}),
                    noRetryOnRateLimit: true,
                    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
                    ...(opts.signal ? { signal: opts.signal } : {}),
                });
                if (!result.ok) return { ok: false as const, error: result.error };
                for (const message of result.messages) {
                    if (message.ts === threadTs) {
                        parent ??= message;
                        continue;
                    }
                    fetchedReplyCount += 1;
                    newestReplies.push(message);
                }
                if (newestReplies.length > THREAD_FETCH_LIMIT) {
                    newestReplies.splice(0, newestReplies.length - THREAD_FETCH_LIMIT);
                }
                const nextCursor = result.nextCursor;
                if (!nextCursor || nextCursor === cursor || opts.signal?.aborted) break;
                cursor = nextCursor;
            }
            const messages = parent ? [parent, ...newestReplies] : newestReplies;

            const ids: string[] = [];
            const isBotById = new Map<string, boolean>();
            const userIdById = new Map<string, string>();
            for (const message of messages) {
                // Bot marker first: `user` alone does not prove a human.
                const botId = message.botId;
                const id = botId || message.user;
                if (!id || isBotById.has(id)) continue;
                isBotById.set(id, Boolean(botId));
                // A granular-permission app message carries both; keep the user
                // id so self-detection still works downstream.
                if (botId && message.user) userIdById.set(id, message.user);
                ids.push(id);
                if (ids.length >= MAX_PARTICIPANTS) break;
            }
            // Cache-only name resolution: this is an inbound hot path, and an
            // unresolved participant shown by id is better than a round trip.
            const names = getCachedSlackIdentities(opts.teamId, ids);
            // Slack's own count on the parent is authoritative. The fetched
            // window is capped at 50, so length-1 would report a 500-reply
            // thread as 49.
            const replyCount = typeof parent?.replyCount === 'number' ? parent.replyCount : fetchedReplyCount;
            const info: SlackThreadInfo = {
                threadTs,
                replyCount,
                participants: ids.map(id => {
                    const userId = userIdById.get(id);
                    return {
                        id,
                        name: names.get(id)?.name ?? id,
                        isBot: isBotById.get(id) === true,
                        ...(userId ? { userId } : {}),
                    };
                }),
                // Retain only what the prefetch renders, with bounded text: a
                // cached thread must not pin megabytes of message bodies.
                messages: messages.map(message => ({
                    ...message,
                    text: cap(message.text, PREFETCH_TEXT_MAX),
                    ...(message.files ? { files: [] } : {}),
                })),
                resolved: true,
            };
            if (parent?.text) info.parentText = cap(parent.text, PARENT_TEXT_MAX);
            return { ok: true as const, value: info };
        },
    });
    return value as SlackThreadInfo;
}

/** Names for ids, from cache only. Misses are simply absent. */
export function cachedNameMap(teamId: string, ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, identity] of getCachedSlackIdentities(teamId, ids)) {
        out.set(id, identity.name);
    }
    return out;
}

/**
 * Drop every cached conversation. Wired to the Slack runtime lifecycle so a
 * workspace switch cannot serve names from the previous team.
 */
export function resetSlackConversationCache(): void {
    conversationCache.reset();
    lastStartAt.clear();
}

export function slackConversationCacheStats(): { conversations: number; threads: number } {
    const stats = conversationCache.stats();
    return { conversations: stats.entries.conversation, threads: stats.entries.thread };
}

/** Test hook: the 1.2s start gate would otherwise serialize unit tests. */
export function resetConversationRateLimitForTest(): void {
    lastStartAt.clear();
}
