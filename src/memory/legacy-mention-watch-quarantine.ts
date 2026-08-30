// ─── Legacy mention-watch quarantine ─────────────────
// v1 ledger rows recorded no workspace or user, so they cannot be migrated into
// the v2 key without guessing whose they were — and a wrong guess is the
// misattribution v2 exists to prevent. Leaving them and starting fresh is not
// free either: a watch with no cursor walks backward through all reachable
// history and re-answers what it already answered.
//
// So a job with v1 rows is HELD OUT of scheduling until an operator restarts it
// with a fresh floor. Two properties make this correct rather than annoying:
//
// DURABLE. The marker lives in the database, not in heartbeat.json. The file is
// the operator intent; quarantine is the system judgement. Written to one place
// they erase each other, and a file rewrite cannot be made atomic with the
// table creation that detected the problem.
//
// NOT ONE-SHOT. Detection also has to catch a job that was absent at upgrade
// time and returns under the same id later, which is the original defect
// arriving by another road.

import {
    countLegacyMentionWatchRows,
    insertLegacyQuarantine,
    getLegacyQuarantine,
    requarantineLegacy,
    commitLegacyFreshStart,
} from '../core/db.js';

export type QuarantineStatus = 'pending' | 'resolved';

export type QuarantineRow = {
    jobId: string;
    status: QuarantineStatus;
    resolution?: string;
};

/** Record every job that still has v1 rows.
 *
 *  Idempotent by INSERT OR IGNORE, so running it on every load is safe and a
 *  job already resolved is not dragged back to pending. Re-quarantine after a
 *  rollback is a separate, deliberate transition below. */
export function detectLegacyMentionWatch(now: number): string[] {
    const rows = countLegacyMentionWatchRows.all() as Array<{ job_id: string }>;
    const detected: string[] = [];
    for (const row of rows) {
        if (!row.job_id) continue;
        const existing = getLegacyQuarantine.get(row.job_id) as { status?: string } | undefined;
        if (existing === undefined) {
            insertLegacyQuarantine.run(row.job_id, now);
            detected.push(row.job_id);
            continue;
        }
        // Resolved, yet v1 rows are back. The only way that happens is a
        // DOWNGRADE: an older build still holds v1 prepared statements and writes
        // to the tables this build stopped using. Those receipts exist only in v1,
        // so resuming on the v2 ledger would answer them again. Re-quarantine
        // rather than trusting the old resolution.
        if (existing.status === 'resolved') {
            requarantineLegacy.run(now, row.job_id);
            detected.push(row.job_id);
        }
    }
    return detected;
}

/** True when this job must not be scheduled, whatever heartbeat.json says. */
export function isQuarantined(jobId: string): boolean {
    const row = getLegacyQuarantine.get(jobId) as { status?: string } | undefined;
    return row?.status === 'pending';
}

export function quarantineState(jobId: string): QuarantineRow | null {
    const row = getLegacyQuarantine.get(jobId) as
        { job_id?: string; status?: string; resolution?: string | null } | undefined;
    if (!row?.job_id || !row.status) return null;
    return {
        jobId: row.job_id,
        status: row.status as QuarantineStatus,
        ...(row.resolution ? { resolution: row.resolution } : {}),
    };
}

export type ApprovalOutcome = 'resolved' | 'already-resolved' | 'not-pending' | 'conflict';

/**
 * Clear a quarantine, in ONE transaction.
 *
 * Archive, delete, and the status flip have to succeed or fail together. Split
 * apart they produce two half-states: resolved with v1 rows still present, which
 * re-quarantines immediately on the next load, or rows gone while still pending,
 * which is safe but makes a retry ambiguous.
 *
 * The caller must have already written the new floor to heartbeat.json AND had
 * the rename succeed. That ordering is the crash-safety argument: a crash
 * between the two leaves the file updated and the job still pending, which is
 * recoverable by retrying. The reverse order lifts the hold while the old
 * configuration is still live, which replays the backlog.
 */
export function approveLegacyFreshStart(
    jobId: string,
    resolution: string,
    now: number,
): ApprovalOutcome {
    const row = getLegacyQuarantine.get(jobId) as { status?: string; resolution?: string | null } | undefined;
    if (row === undefined) return 'not-pending';
    if (row.status === 'resolved') {
        // A retry of the SAME approval is the caller asking again after a lost
        // response, so report the success it already has. A DIFFERENT resolution
        // is a second, conflicting decision and must not silently overwrite the
        // recorded one.
        return (row.resolution ?? '') === resolution ? 'already-resolved' : 'conflict';
    }
    // One transaction: archive, delete, and the status flip succeed or fail
    // together. See commitLegacyFreshStart for why the halves are not acceptable.
    return commitLegacyFreshStart(jobId, resolution, now) ? 'resolved' : 'not-pending';
}
