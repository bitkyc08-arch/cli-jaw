// ─── Slack Dynamic Lookup (history / replies) ────────
// Read-side of the Slack transport: conversations.history for a channel
// window, conversations.replies for one thread. The agent uses this through
// GET /api/slack/history (and `jaw slack history`) to pull conversation
// context it was not mentioned into. Design + scope facts: devlog
// 260806_slack_thread_dynamic_lookup/020 (§001 for the rate-limit basis —
// internal customer-built apps keep Tier 3, so limit=50 defaults are safe).

import { slackApi, describeSlackError, isRetryableSlackError, type SlackFetch } from './api.js';
import type { SlackFileEvent } from './events.js';
import { redactChannelSecrets } from '../messaging/redact.js';

export type SlackHistoryMessage = {
    ts: string;
    threadTs?: string;
    user?: string;
    botId?: string;
    text: string;
    replyCount?: number;
    subtype?: string;
    /** app_mention 첨부 복구가 소비한다 (attachment-recovery.ts). */
    files?: SlackFileEvent[];
};

export type SlackHistoryResult =
    | { ok: true; messages: SlackHistoryMessage[]; hasMore: boolean }
    | { ok: false; error: string };

export const SLACK_HISTORY_DEFAULT_LIMIT = 50;
export const SLACK_HISTORY_MAX_LIMIT = 200;

type RawMessage = {
    ts?: string; thread_ts?: string; user?: string; bot_id?: string;
    text?: string; reply_count?: number; subtype?: string;
    files?: SlackFileEvent[];
};
type RawHistoryData = { messages?: RawMessage[]; has_more?: boolean };

function clampLimit(limit: number | undefined): number {
    const n = Number(limit) || SLACK_HISTORY_DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(n), 1), SLACK_HISTORY_MAX_LIMIT);
}

function normalize(raw: RawMessage[]): SlackHistoryMessage[] {
    const out: SlackHistoryMessage[] = [];
    for (const m of raw) {
        if (!m || typeof m.ts !== 'string') continue;
        out.push({
            ts: m.ts,
            ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
            ...(m.user ? { user: m.user } : {}),
            ...(m.bot_id ? { botId: m.bot_id } : {}),
            text: typeof m.text === 'string' ? m.text : '',
            ...(typeof m.reply_count === 'number' ? { replyCount: m.reply_count } : {}),
            ...(m.subtype ? { subtype: m.subtype } : {}),
            ...(Array.isArray(m.files) && m.files.length ? { files: m.files } : {}),
        });
    }
    return out;
}

async function callWithRetry(
    token: string,
    method: 'conversations.history' | 'conversations.replies',
    body: Record<string, unknown>,
    fetchImpl?: SlackFetch,
): Promise<SlackHistoryResult> {
    // form-encoded on purpose: conversations.replies REJECTS a JSON body with
    // invalid_arguments ("missing required field: channel/ts") — verified live
    // 2026-08-06 against T0BMJ7RSPHQ. conversations.history accepts both, so
    // both ride the form path for one consistent contract.
    const opts = { form: true as const, ...(fetchImpl ? { fetchImpl } : {}) };
    let result = await slackApi<RawHistoryData>(token, method, body, opts);
    if (!result.ok && isRetryableSlackError(result.error)) {
        // One bounded retry after a short pause (Hermes uses 1s/2s; a single
        // 1s attempt is enough for an interactive lookup — the caller can
        // simply retry the whole request otherwise).
        await new Promise(resolve => setTimeout(resolve, 1000));
        result = await slackApi<RawHistoryData>(token, method, body, opts);
    }
    if (!result.ok) {
        // describeSlackError output is operator prose (never echoes tokens);
        // redact defensively anyway since it can embed upstream messages.
        return { ok: false, error: redactChannelSecrets(describeSlackError(result.error, result.data)) };
    }
    return {
        ok: true,
        messages: normalize(result.data?.messages ?? []),
        hasMore: result.data?.has_more === true,
    };
}

/**
 * Channel window: conversations.history (newest first, as Slack returns).
 *
 * `oldest`/`latest` are EXCLUSIVE bounds: a message whose ts equals either
 * bound is omitted unless `inclusive` is set. Fetching one known message
 * therefore needs `{ oldest: ts, inclusive: true, limit: 1 }` — passing
 * oldest===latest without `inclusive` returns an empty list, which silently
 * turns any ts-addressed lookup into a no-op.
 * https://docs.slack.dev/reference/methods/conversations.history/
 */
export function fetchSlackHistory(
    token: string,
    channel: string,
    opts: { limit?: number; oldest?: string; latest?: string; inclusive?: boolean; fetchImpl?: SlackFetch } = {},
): Promise<SlackHistoryResult> {
    return callWithRetry(token, 'conversations.history', {
        channel,
        limit: clampLimit(opts.limit),
        ...(opts.oldest ? { oldest: opts.oldest } : {}),
        ...(opts.latest ? { latest: opts.latest } : {}),
        // Slack ignores `inclusive` when neither bound is present; send it only
        // when it can actually take effect.
        ...(opts.inclusive && (opts.oldest || opts.latest) ? { inclusive: true } : {}),
    }, opts.fetchImpl);
}

/** One thread: conversations.replies (parent message included, oldest first). */
export function fetchSlackReplies(
    token: string,
    channel: string,
    threadTs: string,
    opts: { limit?: number; fetchImpl?: SlackFetch } = {},
): Promise<SlackHistoryResult> {
    return callWithRetry(token, 'conversations.replies', {
        channel,
        ts: threadTs,
        limit: clampLimit(opts.limit),
    }, opts.fetchImpl);
}

const FORMAT_CHAR_CAP = 6000;

/**
 * Chronological plain-text rendering for the agent prompt. Mentions like
 * <@U123> are preserved (they carry speaker identity); everything passes
 * the channel-secret redactor so a token pasted INTO a Slack message can
 * never round-trip back into an agent prompt or terminal.
 */
export function formatHistoryForAgent(
    messages: SlackHistoryMessage[],
    selfUserId?: string | null,
): string {
    const chronological = [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    const lines: string[] = [];
    for (const m of chronological) {
        const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const who = m.user
            ? (m.user === selfUserId ? 'bot(self)' : `<@${m.user}>`)
            : (m.botId ? `bot:${m.botId}` : 'unknown');
        const suffix = m.replyCount ? ` [${m.replyCount} replies]` : '';
        lines.push(`[${when}] ${who}: ${m.text}${suffix}`);
    }
    return redactChannelSecrets(lines.join('\n')).slice(0, FORMAT_CHAR_CAP);
}
