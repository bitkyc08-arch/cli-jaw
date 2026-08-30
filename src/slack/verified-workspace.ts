// ─── Verified Slack workspace ────────────────────────
// The mention-watch ledger is keyed by (workspace, user), so a wrong workspace id
// hands one person cursor to another. That makes the SOURCE of the id part of the
// correctness argument.
//
// `settings.slack.teamId` is not that source. It is written only when empty and
// never re-checked against the token, so a token pointing at workspace B while the
// setting still says A yields rows filed under A.
//
// `initSlack` is not the entry point either: with no app token it returns before
// calling `auth.test` at all, and mention watch needs only a bot token. Depending
// on it would fail-close every outbound-only install that works today.
//
// So this asks Slack directly, once per token, and caches the answer against the
// token that produced it. A token change invalidates the cache by construction.

import { slackApi } from './api.js';
import type { SlackFetch } from './api.js';

type Verified = { token: string; teamId: string; userId: string | null };

let cached: Verified | null = null;

/** Test seam. Never called in production paths. */
export function resetVerifiedSlackWorkspace(): void {
    cached = null;
}

/**
 * The team id Slack itself reports for this token, or null when it cannot be
 * established.
 *
 * Null is a refusal, not a default: a caller that keys durable state on this must
 * skip the work rather than guess. One failed lookup skips one tick, which is
 * recoverable; a guessed key writes into someone else ledger, which is not.
 */
export async function verifiedSlackWorkspace(
    token: string,
    opts: { fetchImpl?: SlackFetch | undefined } = {},
): Promise<{ teamId: string; userId: string | null } | null> {
    const trimmed = token.trim();
    if (!trimmed) return null;
    if (cached && cached.token === trimmed) {
        return { teamId: cached.teamId, userId: cached.userId };
    }
    const auth = await slackApi<{ team_id?: string; user_id?: string }>(
        trimmed,
        'auth.test',
        {},
        opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
    );
    const teamId = String(auth.data?.team_id ?? '').trim();
    if (!auth.ok || !teamId) return null;
    const userId = String(auth.data?.user_id ?? '').trim() || null;
    cached = { token: trimmed, teamId, userId };
    return { teamId, userId };
}
