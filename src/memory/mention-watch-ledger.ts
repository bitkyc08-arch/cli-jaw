// ─── Mention-watch ledger (v2, namespace-scoped) ─────
// Every read and write here takes a WatchNamespace, and the SQL behind it always
// carries all three parts. That is the whole point of routing through one module:
// a bare prepared statement invites a caller to forget the workspace, and one
// forgotten predicate silently merges two people's ledgers.
//
// This does NOT make the mistake structurally impossible — a method could accept
// the namespace and leave it out of its WHERE clause. The real guarantee is the
// A/B symmetry suite in tests/unit/mention-watch-ledger.test.ts, which builds two
// namespaces over the same job/channel/ts and asserts neither can see or disturb
// the other.

import {
    findMentionWatchSeenV2,
    insertMentionWatchSeenV2,
    pruneMentionWatchSeenV2,
    getMentionWatchCursorV2,
    upsertMentionWatchCursorV2,
    setMentionWatchResumeBeforeV2,
    getMentionWatchRotationV2,
    upsertMentionWatchRotationV2,
} from '../core/db.js';

/**
 * Which watch a ledger row belongs to.
 *
 * `workspaceId` is not decoration. Slack identifies a person as (team_id, id),
 * and the runtime can re-authenticate against a different workspace without
 * restarting, so a ledger keyed on the user id alone hands one person cursor to
 * another. It must come from a verified `auth.test` for the token in use, not
 * from mutable settings.
 */
export type WatchNamespace = {
    jobId: string;
    workspaceId: string;
    userId: string;
};

/** Reject anything that cannot be a stable key.
 *
 *  Trimmed once here so a padded id cannot become a second identity for the same
 *  person. An empty part means the caller could not establish identity, and a
 *  ledger write under a guessed key is worse than not writing at all. */
export function watchNamespace(
    jobId: string | null | undefined,
    workspaceId: string | null | undefined,
    userId: string | null | undefined,
): WatchNamespace | null {
    const job = typeof jobId === 'string' ? jobId.trim() : '';
    const workspace = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    const user = typeof userId === 'string' ? userId.trim() : '';
    if (!job || !workspace || !user) return null;
    return { jobId: job, workspaceId: workspace, userId: user };
}

export function hasSeenMention(ns: WatchNamespace, channelId: string, messageTs: string): boolean {
    return findMentionWatchSeenV2.get(ns.jobId, ns.workspaceId, ns.userId, channelId, messageTs) !== undefined;
}

export function recordSeenMention(ns: WatchNamespace, channelId: string, messageTs: string, now: number): void {
    insertMentionWatchSeenV2.run(ns.jobId, ns.workspaceId, ns.userId, channelId, messageTs, now);
}

/** Drop receipts at or below the frontier, which no later scan can reach. */
export function pruneSeenMentions(ns: WatchNamespace, channelId: string, frontier: string): void {
    pruneMentionWatchSeenV2.run(ns.jobId, ns.workspaceId, ns.userId, channelId, frontier);
}

export function readCursor(ns: WatchNamespace, channelId: string): { lastTs?: string; resumeBefore?: string } {
    const row = getMentionWatchCursorV2.get(ns.jobId, ns.workspaceId, ns.userId, channelId) as
        { last_ts?: string; resume_before?: string | null } | undefined;
    if (!row) return {};
    return {
        // The empty string is the placeholder a resume-only write leaves behind;
        // it must never read as a cursor at ts 0.
        ...(row.last_ts ? { lastTs: row.last_ts } : {}),
        ...(row.resume_before ? { resumeBefore: row.resume_before } : {}),
    };
}

export function advanceCursor(ns: WatchNamespace, channelId: string, frontier: string, now: number): void {
    upsertMentionWatchCursorV2.run(ns.jobId, ns.workspaceId, ns.userId, channelId, frontier, now);
}

/** Remember where an unfinished backward walk stopped. */
export function setResumeBefore(
    ns: WatchNamespace, channelId: string, bound: string | null, now: number,
): void {
    setMentionWatchResumeBeforeV2.run(
        ns.jobId, ns.workspaceId, ns.userId, channelId,
        ns.jobId, ns.workspaceId, ns.userId, channelId,
        bound, now,
    );
}

export function readRotation(ns: WatchNamespace): string | undefined {
    const row = getMentionWatchRotationV2.get(ns.jobId, ns.workspaceId, ns.userId) as
        { last_channel_id?: string } | undefined;
    return row?.last_channel_id || undefined;
}

export function recordRotation(ns: WatchNamespace, channelId: string, now: number): void {
    upsertMentionWatchRotationV2.run(ns.jobId, ns.workspaceId, ns.userId, channelId, now);
}
