// ─── Slack public-channel auto-join ──────────────
// The bot can only read a channel it belongs to: conversations.history answers
// not_in_channel otherwise, and unlike a user token there is no "it is public,
// so it is readable" exemption for bots. Joining is therefore the only supported
// route into a channel nobody invited us to, and this module owns that policy.
//
// What this DOES buy: on-demand history lookup (/api/slack/history), being
// mentionable in that channel, and posting there as a member.
// What it does NOT buy: passive answering of ordinary chatter. The inbound gate
// keeps mentionOnly semantics (src/slack/events.ts), so joined channels deliver
// message.channels envelopes that are then discarded. That is deliberate — an
// agent replying to every message in 200 channels is not a feature.
//
// Design + audit history: devlog/_plan/260821_260821-slack-channel-reach/010.

import { log } from '../core/logger.js';
import { redactChannelSecrets } from '../messaging/redact.js';
import { MALFORMED_SLACK_ALLOWLIST } from './events.js';
import {
    listSlackConversations,
    joinSlackConversation,
    type SlackConversationSummary,
    type SlackFetch,
} from './api.js';

export type SlackAutoJoinConfig = {
    enabled: boolean;
    excludeArchived: boolean;
    /** JOIN ATTEMPTS per run, not rows scanned. Spent after filtering. */
    maxJoinsPerRun: number;
    /** Channel ids or names the operator never wants joined. */
    exclude: string[];
};

export type SlackAutoJoinResult = {
    scanned: number;
    joined: string[];
    skipped: number;
    failed: Array<{ id: string; error: string }>;
    cancelled: boolean;
    budgetExhausted: boolean;
    /** Set when a workspace-wide failure stopped the whole run. */
    abortedReason?: string;
};

export const SLACK_AUTO_JOIN_DEFAULTS: SlackAutoJoinConfig = {
    // On by default: the whole point is that the agent can reach conversations
    // nobody thought to invite it to. Bounded by maxJoinsPerRun and exclude.
    enabled: true,
    excludeArchived: true,
    maxJoinsPerRun: 200,
    exclude: [],
};

/**
 * conversations.list is Tier 2 (20+/min). One call per 3s holds us at 20/min
 * exactly, which is the documented floor rather than the real ceiling.
 */
const LIST_INTERVAL_MS = 3000;
/**
 * conversations.join is Tier 3 (50+/min). 1300ms leaves margin under the floor;
 * a full 200-join budget therefore takes a little over four minutes. That is
 * fine — the scan runs in the background and nothing waits on it.
 */
const JOIN_INTERVAL_MS = 1300;
/** What to wait when Slack rate-limits us without saying for how long. */
const DEFAULT_RETRY_AFTER_MS = 5000;
/** Per-call retries for 429 only. A retry is not a failure until it runs out. */
const MAX_RATELIMIT_RETRIES = 3;
/** Page size Slack recommends; larger values are silently truncated anyway. */
const PAGE_SIZE = 200;
/** Refuse to walk forever if Slack keeps handing back cursors. */
const MAX_PAGES = 100;
/** A workspace that refuses this many joins in a row is refusing by policy. */
const MAX_CONSECUTIVE_NO_PERMISSION = 3;

/**
 * Errors that prove the TOKEN or the WORKSPACE is unusable, not the channel.
 * Continuing to hammer hundreds of channels after one of these is wrong.
 */
const FATAL_ERRORS = new Set([
    'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
    'token_expired', 'token_revoked', 'team_access_not_granted',
    'ekm_access_denied', 'org_login_required',
]);

const MAX_EXCLUDE_ENTRIES = 200;
const MIN_JOINS_PER_RUN = 1;
const MAX_JOINS_PER_RUN = 1000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boolOr(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

/**
 * One comparison form for channel ids and names.
 *
 * Slack stores names without the leading '#', operators type it with one, and
 * ids are case-sensitive in Slack but compared case-insensitively here so a
 * hand-typed 'c123abc' still matches.
 */
function matchKey(value: string): string {
    return value.trim().replace(/^#/, '').toLowerCase();
}

/**
 * Merge a partial autoJoin patch onto a base without dropping siblings, and
 * normalize the result.
 *
 * The channel merges in config.ts and settings-merge.ts are one level deep,
 * which is right for flat credential fields and wrong for a nested group: a
 * stored {autoJoin:{enabled:false}} would otherwise erase maxJoinsPerRun and
 * exclude. Same shape and reasoning as mergeAckSettings, and shared by the boot
 * merge and the API/watch patch path so the ingresses cannot diverge.
 *
 * Normalization is not cosmetic. maxJoinsPerRun reaches a loop that mutates a
 * live workspace, so NaN, -1 and '500' must not survive to that point.
 */
export function mergeSlackAutoJoin(base: unknown, patch: unknown): SlackAutoJoinConfig {
    const baseRecord = isPlainRecord(base) ? base : {};
    const patchRecord = isPlainRecord(patch) ? patch : {};
    const merged: Record<string, unknown> = { ...baseRecord, ...patchRecord };
    return {
        enabled: boolOr(merged['enabled'], SLACK_AUTO_JOIN_DEFAULTS.enabled),
        excludeArchived: boolOr(merged['excludeArchived'], SLACK_AUTO_JOIN_DEFAULTS.excludeArchived),
        maxJoinsPerRun: normalizeBudget(merged['maxJoinsPerRun']),
        exclude: normalizeExclude(merged['exclude']),
    };
}

function normalizeBudget(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return SLACK_AUTO_JOIN_DEFAULTS.maxJoinsPerRun;
    const floored = Math.floor(n);
    if (floored < MIN_JOINS_PER_RUN) return MIN_JOINS_PER_RUN;
    if (floored > MAX_JOINS_PER_RUN) return MAX_JOINS_PER_RUN;
    return floored;
}

function normalizeExclude(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        // Slack stores channel names without the leading '#', but operators type
        // it. Accept both rather than silently ignoring half the input.
        const trimmed = entry.trim().replace(/^#/, '');
        if (!trimmed) continue;
        out.push(trimmed);
        if (out.length >= MAX_EXCLUDE_ENTRIES) break;
    }
    return out;
}

/** Abortable sleep. A pending 3s pace must not hold shutdown open for 3s. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
        const timer = setTimeout(finish, ms);
        function finish(): void {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        }
        signal?.addEventListener('abort', finish, { once: true });
    });
}

export type SlackAutoJoinOptions = {
    token: string;
    config: SlackAutoJoinConfig;
    signal?: AbortSignal;
    /** False once a newer init generation owns the transport. */
    isCurrent?: () => boolean;
    fetchImpl?: SlackFetch;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /**
     * The inbound allowlist (`slack.channelIds`), already parsed.
     *
     * Empty means every conversation, which is the shipped default and the
     * case auto-join exists for. A NON-EMPTY list is an operator saying this
     * instance listens to these conversations and no others, and joining
     * outside it would hand the agent read access to channels the same
     * operator deliberately put out of reach (#406 is the mirror of this
     * mistake). Auto-join stays inside the line the operator drew.
     *
     * A MALFORMED value is a third case, and the one that used to fail open.
     * `readSlackAllowlist` reports it as a single unmatchable sentinel, which
     * denies every channel inbound. Read here as an ordinary one-entry list it
     * would merely skip everything — right by accident, and only for as long as
     * the sentinel stays unmatchable. It is now detected and stops the run.
     */
    allowlist?: readonly string[];
};

/**
 * Scan public channels and join the ones we are not in.
 *
 * Never throws: a background reconciliation must not be able to take the
 * transport down with it. Every outcome is reported in the result instead.
 */
export async function runSlackAutoJoin(opts: SlackAutoJoinOptions): Promise<SlackAutoJoinResult> {
    const result: SlackAutoJoinResult = {
        scanned: 0, joined: [], skipped: 0, failed: [],
        cancelled: false, budgetExhausted: false,
    };
    const { token, config } = opts;
    if (!config.enabled || !token) return result;

    // A malformed inbound allowlist means the operator's boundary could not be
    // read. Joining is a VISIBLE workspace mutation, so an unreadable boundary
    // must stop the run outright rather than be treated as one odd channel name
    // that happens to match nothing. Skipping every channel would look the same
    // today and silently start joining the moment the sentinel changes.
    if ((opts.allowlist ?? []).includes(MALFORMED_SLACK_ALLOWLIST)) {
        result.abortedReason = 'malformed_allowlist';
        log.warn('[slack:autojoin] slack.channelIds is malformed — refusing to join any channel.'
            + ' Fix the allowlist (an array of channel ids) and restart.');
        return result;
    }

    const sleep = opts.sleep ?? defaultSleep;
    const signal = opts.signal;
    const isCurrent = opts.isCurrent ?? (() => true);
    // Normalized here as well as in mergeSlackAutoJoin. The runner must not
    // depend on having been handed a merged config: a caller passing
    // ['#random'] straight through would otherwise compare '#random' against
    // the bare name Slack returns and silently join the channel it was told
    // to leave alone.
    const excluded = new Set(config.exclude.map(matchKey).filter(Boolean));
    // An empty allowlist means every conversation; a non-empty one is a
    // boundary the operator drew, and auto-join respects it.
    const allowed = new Set((opts.allowlist ?? []).map(matchKey).filter(Boolean));
    const callOptions = {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(signal ? { signal } : {}),
    };

    const stopped = (): boolean => Boolean(signal?.aborted) || !isCurrent();

    let cursor: string | undefined;
    let pages = 0;
    let budget = config.maxJoinsPerRun;
    let consecutiveNoPermission = 0;
    let joinAttempts = 0;

    while (pages < MAX_PAGES) {
        if (stopped()) { result.cancelled = true; return result; }
        if (pages > 0) {
            await sleep(LIST_INTERVAL_MS, signal);
            if (stopped()) { result.cancelled = true; return result; }
        }
        pages++;

        const page = await withRateLimitRetry(
            () => listSlackConversations(token, {
                ...(cursor ? { cursor } : {}),
                limit: PAGE_SIZE,
                types: 'public_channel',
                excludeArchived: config.excludeArchived,
            }, callOptions),
            sleep, signal, stopped,
        );
        if (stopped()) { result.cancelled = true; return result; }
        if (!page.ok) {
            result.abortedReason = page.error;
            if (!FATAL_ERRORS.has(page.error)) {
                result.failed.push({ id: 'conversations.list', error: page.error });
            }
            log.warn(redactChannelSecrets('[slack:autojoin] conversations.list failed: ' + page.error));
            return result;
        }

        const channels: SlackConversationSummary[] = page.data?.channels ?? [];
        result.scanned += channels.length;

        for (const channel of channels) {
            const id = String(channel.id ?? '').trim();
            if (!id) { result.skipped++; continue; }
            if (shouldSkipChannel(channel, id, excluded, allowed, config)) { result.skipped++; continue; }

            // Budget is spent HERE, after filtering — never on rows merely
            // scanned. A workspace where the bot already belongs to 500
            // channels must not exhaust its budget before reaching the one
            // channel it actually needs to join.
            if (budget <= 0) {
                result.budgetExhausted = true;
                log.info('[slack:autojoin] join budget exhausted (' + config.maxJoinsPerRun
                    + ') — remaining channels wait for the next start');
                return result;
            }
            if (stopped()) { result.cancelled = true; return result; }

            // Pace between joins, not before the first one.
            if (joinAttempts > 0) {
                await sleep(JOIN_INTERVAL_MS, signal);
                if (stopped()) { result.cancelled = true; return result; }
            }

            budget--;
            joinAttempts++;
            const joined = await withRateLimitRetry(
                () => joinSlackConversation(token, id, callOptions),
                sleep, signal, stopped,
            );
            if (stopped()) { result.cancelled = true; return result; }

            if (joined.ok) {
                result.joined.push(id);
                consecutiveNoPermission = 0;
                continue;
            }
            if (FATAL_ERRORS.has(joined.error)) {
                result.abortedReason = joined.error;
                log.warn(redactChannelSecrets('[slack:autojoin] stopping: ' + joined.error));
                return result;
            }
            // A channel-scoped refusal is normal (archived, converted to
            // private, admin-restricted) and must not end the scan. A RUN of
            // them is a workspace policy saying no, and continuing would be
            // hundreds of pointless calls.
            if (joined.error === 'no_permission' || joined.error === 'restricted_action') {
                consecutiveNoPermission++;
                if (consecutiveNoPermission >= MAX_CONSECUTIVE_NO_PERMISSION) {
                    result.abortedReason = joined.error;
                    result.failed.push({ id, error: joined.error });
                    log.warn(redactChannelSecrets('[slack:autojoin] stopping after ' + consecutiveNoPermission
                        + ' consecutive ' + joined.error + ' — workspace policy refuses joins'));
                    return result;
                }
            } else {
                consecutiveNoPermission = 0;
            }
            result.failed.push({ id, error: joined.error });
        }

        const next = String(page.data?.response_metadata?.next_cursor ?? '').trim();
        // A page filtered down to nothing still carries a cursor — keep walking
        // rather than reading 'no work on this page' as the end of the list.
        if (!next) break;
        cursor = next;
    }

    return result;
}

function shouldSkipChannel(
    channel: SlackConversationSummary,
    id: string,
    excluded: Set<string>,
    allowed: Set<string>,
    config: SlackAutoJoinConfig,
): boolean {
    if (channel.is_member === true) return true;
    // conversations.join cannot enter a private channel; only an invite can.
    if (channel.is_private === true) return true;
    if (config.excludeArchived && channel.is_archived === true) return true;
    if (excluded.has(id.toLowerCase())) return true;
    const name = String(channel.name ?? '').trim().toLowerCase();
    if (name && excluded.has(name)) return true;
    // A configured allowlist is the operator's inbound boundary. Joining past
    // it would give the agent history access to conversations that same
    // operator silenced.
    if (allowed.size > 0 && !allowed.has(id.toLowerCase()) && !(name && allowed.has(name))) return true;
    return false;
}

type RetryableResult = { ok: boolean; error?: string; retryAfterMs?: number };

/**
 * Retry a call that came back rate-limited, honoring Retry-After.
 *
 * 429 is not a channel failure — recording it as one and moving on would keep
 * flooding an API that just asked us to stop.
 */
async function withRateLimitRetry<T extends RetryableResult>(
    call: () => Promise<T>,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal: AbortSignal | undefined,
    stopped: () => boolean,
): Promise<T & { error: string }> {
    let attempt = 0;
    let last = await call();
    while (!last.ok && last.error === 'ratelimited' && attempt < MAX_RATELIMIT_RETRIES) {
        if (stopped()) break;
        attempt++;
        await sleep(last.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, signal);
        if (stopped()) break;
        last = await call();
    }
    return { ...last, error: last.error ?? '' } as T & { error: string };
}
