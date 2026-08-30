// ─── Heartbeat mention watch ─────────────────────────
// One tick of "find messages that tagged this person, answer each in its
// thread". The scan itself lives in src/slack/mention-watch.ts; this module owns
// the parts that must be durable: which messages are already answered, how far
// each channel has been read, and the rule that the SERVER posts the answer.
//
// WHY THE SERVER SENDS
//
// Letting the agent post directly makes a tick's success meaningless as evidence
// of delivery: it can answer three threads, fail on two sends, and still exit
// with a clean transcript. Here each item is a separate round trip — ask, send,
// record — so a receipt exists per message and a partial tick leaves the rest
// unrecorded for the next one to pick up.
//
// The guarantee is AT-LEAST-ONCE. If the process dies between a successful post
// and its 'seen' write, the next tick answers that message again. Exactly-once
// needs a durable reservation taken before the send plus an ambiguous state to
// resolve afterwards, which is more machinery than this is worth today. The limit
// is written down rather than papered over.

import {
    findMentionWatchSeen,
    insertMentionWatchSeen,
    pruneMentionWatchSeen,
    getMentionWatchCursor,
    upsertMentionWatchCursor,
    setMentionWatchResumeBefore,
    getMentionWatchRotation,
    upsertMentionWatchRotation,
} from '../core/db.js';
import { scanSlackMentions, MENTION_WATCH_DEFAULT_MAX_HITS } from '../slack/mention-watch.js';
import type { MentionHit } from '../slack/mention-watch.js';
import type { HeartbeatMentionWatch } from '../core/config.js';

export type MentionWatchTickResult = {
    /** Messages answered and recorded. */
    answered: number;
    /** Hits the agent chose not to answer. Recorded as handled, because deciding
     *  to stay quiet is a decision about that message. */
    quiet: number;
    /** Sends that failed. Their receipts are NOT written, so they retry. */
    failed: number;
    /** Channels the scan could not read. */
    unreadable: string[];
    /** Configured channels outside the current Slack allowlist, which this tick
     *  did not scan. An answer addressed there would be refused with a 403, so
     *  scanning them would only produce work that cannot be delivered. */
    unauthorized: string[];
    /** Channels beyond the scanner's ceiling. Non-empty means a hand-edited file
     *  got past config validation; reported so it is visible rather than silent. */
    overflow: string[];
    /** Set when the tick stopped early. */
    stoppedBecause?: 'rate_limited' | 'yielded' | 'aborted';
};

export type MentionWatchDeps = {
    /** Slack bot token. */
    token: string;
    /** The bot own user id, so its posts never read as a hit. */
    selfUserId: string | null;
    /** Channels answers may be addressed to, read FRESH for this tick. */
    allowlist: readonly string[];
    /** Ask the agent for one answer. Returns null to say nothing. */
    answer(hit: MentionHit, job: Record<string, unknown>): Promise<string | null>;
    /** Post it. Returns false when delivery failed. */
    send(hit: MentionHit, text: string): Promise<boolean>;
    /** Called before EACH item. A non-null reason abandons the rest of the tick.
     *
     *  Checking once before the loop is not enough: the first answer can take
     *  minutes, and a user message or a PABCD transition arriving in that window
     *  has to win. Unanswered items are not recorded, so the next tick has them. */
    yieldNow(): 'yielded' | null;
    fetchImpl?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
    now?: () => number;
    log?: (message: string) => void;
};

/** Intersect the job's channels with the live allowlist.
 *
 *  Re-derived every tick on purpose. The allowlist can shrink after a job was
 *  saved, and the timer holds the job object as it was — so a check made only at
 *  save time would send this scan after channels whose answers now 403. */
function authorizedChannels(
    configured: readonly string[],
    allowlist: readonly string[],
): { allowed: string[]; rejected: string[] } {
    // An empty allowlist does NOT mean "anything goes" for an explicitly
    // addressed send. `authorizeExplicitTarget` falls back to vouching only for
    // conversations this process has evidence for — last-active, latest-seen, or a
    // bound conversation — so a channel with no such evidence is refused with a
    // 403 (src/messaging/send.ts:301).
    //
    // Reading it anyway would be worse than useless: the scan finds a mention,
    // pays for an agent turn to answer it, gets a 403, records no receipt, and
    // does the whole thing again next tick. Refusing to scan is the honest
    // answer, and `unauthorized` says which channels need an allowlist entry.
    if (allowlist.length === 0) return { allowed: [], rejected: [...configured] };
    const permitted = new Set(allowlist);
    const allowed: string[] = [];
    const rejected: string[] = [];
    for (const id of configured) (permitted.has(id) ? allowed : rejected).push(id);
    return { allowed, rejected };
}

export async function runMentionWatchTick(
    jobId: string,
    job: Record<string, unknown>,
    watch: HeartbeatMentionWatch,
    deps: MentionWatchDeps,
): Promise<MentionWatchTickResult> {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? (() => {});
    const result: MentionWatchTickResult = {
        answered: 0, quiet: 0, failed: 0,
        unreadable: [], unauthorized: [], overflow: [],
    };

    const { allowed, rejected } = authorizedChannels(watch.channelIds, deps.allowlist);
    result.unauthorized = rejected;
    if (rejected.length) {
        log(`mention watch: ${rejected.length} channel(s) outside the Slack allowlist, skipped: ${rejected.join(', ')}`);
    }
    if (allowed.length === 0) return result;

    const rotation = getMentionWatchRotation.get(jobId) as { last_channel_id?: string } | undefined;
    const scan = await scanSlackMentions(deps.token, {
        userId: watch.userId,
        channelIds: allowed,
        selfUserId: deps.selfUserId,
        maxHits: watch.maxHits ?? MENTION_WATCH_DEFAULT_MAX_HITS,
        ...(watch.since ? { since: watch.since } : {}),
        ...(rotation?.last_channel_id ? { startAfterChannelId: rotation.last_channel_id } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        state: {
            cursor: (channelId) => {
                const row = getMentionWatchCursor.get(jobId, channelId) as { last_ts?: string } | undefined;
                // An empty string is the placeholder a resume-only write leaves
                // behind; it must not read as a cursor at ts 0.
                return row?.last_ts ? row.last_ts : undefined;
            },
            resumeBefore: (channelId) => {
                const row = getMentionWatchCursor.get(jobId, channelId) as { resume_before?: string | null } | undefined;
                return row?.resume_before ? row.resume_before : undefined;
            },
            seen: (channelId, ts) => findMentionWatchSeen.get(jobId, channelId, ts) !== undefined,
        },
    });

    result.unreadable = scan.failed.map(f => f.channelId);
    result.overflow = scan.overflowChannels;
    if (scan.overflowChannels.length) {
        log(`mention watch: ${scan.overflowChannels.length} channel(s) past the scanner ceiling were not read: ${scan.overflowChannels.join(', ')}`);
    }
    for (const failure of scan.failed) log(`mention watch: ${failure.channelId} unreadable: ${failure.error}`);

    // Rotation and resume bounds are persisted BEFORE any answering, because they
    // describe what the SCAN did. Writing them afterwards would lose them
    // whenever the answering loop exits early, and the next tick would repeat the
    // same reads.
    if (scan.lastChannelId) upsertMentionWatchRotation.run(jobId, scan.lastChannelId, now());
    for (const [channelId, bound] of scan.resumeBounds) {
        setMentionWatchResumeBefore.run(jobId, channelId, jobId, channelId, bound, now());
    }

    for (const hit of scan.hits) {
        if (deps.signal?.aborted) { result.stoppedBecause = 'aborted'; break; }
        // Re-checked per item, not once for the batch: the previous answer may
        // have taken minutes, and a user who started typing during it outranks
        // the rest of this backlog.
        const yielded = deps.yieldNow();
        if (yielded) { result.stoppedBecause = yielded; break; }

        let text: string | null;
        try {
            text = await deps.answer(hit, job);
        } catch (error) {
            result.failed += 1;
            log(`mention watch: answer failed for ${hit.channelId}/${hit.ts}: ${(error as Error).message}`);
            continue;
        }
        if (!text) {
            // Deliberate silence is a decision about this message, so record it:
            // otherwise every tick asks again and pays for the same answer.
            insertMentionWatchSeen.run(jobId, hit.channelId, hit.ts, now());
            result.quiet += 1;
            continue;
        }
        const sent = await deps.send(hit, text);
        if (!sent) {
            // No receipt on a failed send: the next tick must be free to retry.
            result.failed += 1;
            log(`mention watch: send failed for ${hit.channelId}/${hit.ts}`);
            continue;
        }
        insertMentionWatchSeen.run(jobId, hit.channelId, hit.ts, now());
        result.answered += 1;
    }

    if (scan.rateLimited) result.stoppedBecause ??= 'rate_limited';

    // Cursors move LAST, because only now is delivery known.
    //
    // The scanner's frontier deliberately stops BEFORE any hit it carried: at scan
    // time it cannot know whether that message will be answered, so it refuses to
    // step over it. Delivery is this function's knowledge, so the settled hits are
    // folded in here. Without that the cursor would never pass a mention at all
    // and every tick would re-read the same window forever.
    const unsettled = new Set<string>();
    const settledHigh = new Map<string, string>();
    for (const hit of scan.hits) {
        if (findMentionWatchSeen.get(jobId, hit.channelId, hit.ts) === undefined) {
            unsettled.add(hit.channelId);
            continue;
        }
        const high = settledHigh.get(hit.channelId);
        if (high === undefined || Number(hit.ts) > Number(high)) settledHigh.set(hit.channelId, hit.ts);
    }

    const advanceTo = new Map<string, string>();
    for (const [channelId, frontier] of scan.cursors) advanceTo.set(channelId, frontier);
    for (const [channelId, ts] of settledHigh) {
        // Only for a channel whose backward walk actually reached the cursor. A
        // truncated walk leaves an unread gap BELOW this span, and moving the
        // cursor above that gap would skip whatever is in it for good.
        if (scan.resumeBounds.get(channelId) !== null) continue;
        const existing = advanceTo.get(channelId);
        if (existing === undefined || Number(ts) > Number(existing)) advanceTo.set(channelId, ts);
    }

    for (const [channelId, frontier] of advanceTo) {
        // One unsettled hit holds the whole channel: the cursor may not pass a
        // message this tick failed to answer, even if a later one succeeded.
        if (unsettled.has(channelId)) continue;
        upsertMentionWatchCursor.run(jobId, channelId, frontier, now());
        // Receipts at or below the frontier can never be consulted again: the
        // next scan reads strictly above it.
        pruneMentionWatchSeen.run(jobId, channelId, frontier);
    }

    return result;
}
