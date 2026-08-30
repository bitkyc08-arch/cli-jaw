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
    /** `error` is operator prose, for logs and UI. `code` is Slack's raw error
     *  string, for callers that must BRANCH on the reason — a rate limit means
     *  "stop asking", while `not_in_channel` means "skip this one and continue".
     *  Reading that decision out of the prose would break the moment the wording
     *  changes. Absent when the failure had no Slack error code. */
    | { ok: false; error: string; code?: string };

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

export type SlackHistoryOpts = {
    limit?: number;
    fetchImpl?: SlackFetch;
    /** Cancels the request, the retry wait, and any further attempt. */
    signal?: AbortSignal;
    /**
     * Skip the bounded retry when Slack answers `ratelimited`.
     *
     * Default false keeps today's behavior for `/api/slack/history` and
     * attachment recovery. Enrichment callers set it: they own a suppression
     * window of their own, and retrying a 429 fires a second request before that
     * window can be applied.
     */
    noRetryOnRateLimit?: boolean;
};

/**
 * Abortable sleep. A cancelled ingress must not hold the loop open, which is
 * why the timer is unref'd by default.
 *
 * `keepAlive` exists for callers that are AWAITING the pause as part of their
 * result: an unref'd timer lets the process exit mid-await, and the pending
 * promise then resolves never. Under CI load that surfaced as
 * "Promise resolution is still pending but the event loop has already
 * resolved" on the retry-backoff path.
 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal, keepAlive = false): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
        const timer = setTimeout(finish, ms);
        if (!keepAlive) timer.unref?.();
        function finish(): void {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        }
        signal?.addEventListener('abort', finish, { once: true });
    });
}

async function callWithRetry(
    token: string,
    method: 'conversations.history' | 'conversations.replies',
    body: Record<string, unknown>,
    opts: SlackHistoryOpts = {},
): Promise<SlackHistoryResult> {
    // form-encoded on purpose: conversations.replies REJECTS a JSON body with
    // invalid_arguments ("missing required field: channel/ts") — verified live
    // 2026-08-06 against T0BMJ7RSPHQ. conversations.history accepts both, so
    // both ride the form path for one consistent contract.
    const callOpts = {
        form: true as const,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    };
    let result = await slackApi<RawHistoryData>(token, method, body, callOpts);
    // A 429 is retried by default (existing callers depend on it), but an
    // enrichment caller opts out: it applies its own suppression window, and a
    // retry would fire a second request before that window exists.
    const retryable = isRetryableSlackError(result.error)
        && !(opts.noRetryOnRateLimit && result.error === 'ratelimited');
    if (!result.ok && retryable && !opts.signal?.aborted) {
        // One bounded retry after a short pause (Hermes uses 1s/2s; a single
        // 1s attempt is enough for an interactive lookup — the caller can
        // simply retry the whole request otherwise).
        // keepAlive: the caller is awaiting this pause to produce its result,
        // so the process must not be allowed to exit mid-backoff.
        await sleepUnlessAborted(1000, opts.signal, true);
        // Re-check: the wait is where a cancel usually lands.
        if (!opts.signal?.aborted) {
            result = await slackApi<RawHistoryData>(token, method, body, callOpts);
        }
    }
    if (!result.ok) {
        // describeSlackError output is operator prose (never echoes tokens);
        // redact defensively anyway since it can embed upstream messages.
        return {
            ok: false,
            error: redactChannelSecrets(describeSlackError(result.error, result.data)),
            ...(result.error ? { code: result.error } : {}),
        };
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
    opts: SlackHistoryOpts & { oldest?: string; latest?: string; inclusive?: boolean } = {},
): Promise<SlackHistoryResult> {
    return callWithRetry(token, 'conversations.history', {
        channel,
        limit: clampLimit(opts.limit),
        ...(opts.oldest ? { oldest: opts.oldest } : {}),
        ...(opts.latest ? { latest: opts.latest } : {}),
        // Slack ignores `inclusive` when neither bound is present; send it only
        // when it can actually take effect.
        ...(opts.inclusive && (opts.oldest || opts.latest) ? { inclusive: true } : {}),
    }, opts);
}

/** One thread: conversations.replies (parent message included, oldest first). */
export function fetchSlackReplies(
    token: string,
    channel: string,
    threadTs: string,
    opts: SlackHistoryOpts = {},
): Promise<SlackHistoryResult> {
    return callWithRetry(token, 'conversations.replies', {
        channel,
        ts: threadTs,
        limit: clampLimit(opts.limit),
    }, opts);
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
    names?: ReadonlyMap<string, string>,
): string {
    const chronological = [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    const lines: string[] = [];
    for (const m of chronological) {
        const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ');
        // A resolved name never replaces the id — the agent still needs the id for
        // any follow-up API call, so both are shown.
        const resolvedName = m.user ? names?.get(m.user) : m.botId ? names?.get(m.botId) : undefined;
        const who = m.user
            ? (m.user === selfUserId
                ? 'bot(self)'
                : resolvedName ? `${resolvedName} (${m.user})` : `<@${m.user}>`)
            : (m.botId
                ? (resolvedName ? `${resolvedName} (bot:${m.botId})` : `bot:${m.botId}`)
                : 'unknown');
        const suffix = m.replyCount ? ` [${m.replyCount} replies]` : '';
        lines.push(`[${when}] ${who}: ${m.text}${suffix}`);
    }
    return redactChannelSecrets(lines.join('\n')).slice(0, FORMAT_CHAR_CAP);
}
