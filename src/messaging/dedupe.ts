// ─── Delivery Deduplication ──────────────────────────
// A time-bounded seen-set, shared by the channels that can be handed the same
// delivery twice: a reconnecting updater replays, and a vendor retries when an
// ack is slow. Processing one twice runs the agent twice.
//
// Promoted from the Slack socket client, which is where this was first got
// right; the shape of the mistakes it avoids is recorded below.

import { log } from '../core/logger.js';

export interface SeenSet {
    /** True when this key has been seen inside the window. Records it if not. */
    seen(key: string): boolean;
    /** Entries currently tracked. Exposed for health reporting and tests. */
    size(): number;
}

/**
 * @param ttlMs   how long a delivery id stays remembered
 * @param sweepAt size that triggers an expiry sweep
 */
export function createSeenSet(
    ttlMs: number,
    sweepAt = 5_000,
    maxTracked = MAX_TRACKED_DELIVERIES,
): SeenSet {
    // A Map iterates in insertion order and every entry is recorded with the
    // current time, so the oldest entries are always at the front. That makes
    // expiry a walk from the head that stops at the first live entry —
    // proportional to what actually expired, not to the size of the set.
    //
    // Scanning the whole map instead was O(n) per insertion once it passed the
    // sweep threshold, which is O(n²) over a burst: 60,000 ids took five
    // seconds of synchronous work in a path that runs per inbound message.
    const seenAt = new Map<string, number>();
    let warnedAtBudget = false;
    // Head-ordered expiry assumes entries are stamped in non-decreasing order.
    // Date.now() can go backwards — NTP correction, a manual clock change — and
    // one older stamp behind a newer one parks an expired entry in front of the
    // walk's stopping point, where it holds a slot until the newer one expires.
    // Clamping to the last observation keeps the sequence monotonic.
    let lastObserved = 0;
    const monotonicNow = () => {
        lastObserved = Math.max(lastObserved, Date.now());
        return lastObserved;
    };

    const dropExpired = (now: number) => {
        for (const [id, when] of seenAt) {
            if (now - when < ttlMs) break; // everything after this is younger
            seenAt.delete(id);
        }
    };

    return {
        seen(key: string): boolean {
            const now = monotonicNow();
            const at = seenAt.get(key);
            if (at !== undefined && now - at < ttlMs) return true;
            // An expired key being seen again is re-recorded below. Delete it
            // first so the Map re-inserts it at the BACK: insertion order is
            // what makes expiry a walk from the head, and refreshing a key in
            // place would leave a young entry sitting in front of older ones.
            if (at !== undefined) seenAt.delete(key);

            // Expiry drops EXPIRED entries only. Evicting an unexpired id to
            // hit a size target would let a delayed retry through — precisely
            // the duplicate this exists to stop.
            //
            // It runs lazily rather than on a timer, because a timer here
            // outlives the channel that created it; leaked timers were their
            // own defect class in this codebase.
            if (seenAt.size > sweepAt) dropExpired(now);

            // A TTL is not a bound on how many DISTINCT ids arrive inside it.
            // Past the budget, stop admitting new keys: already-tracked ids
            // keep their guarantee, and the set stops growing.
            //
            // The trade is explicit. Under a flood this degrades to "may
            // reprocess a message" rather than "may exhaust memory", and only
            // for ids arriving after the budget is reached.
            if (seenAt.size >= maxTracked) {
                // Reclaim before refusing: the budget is about live entries,
                // and expired ones are not live. Refusing while dead entries
                // hold slots would drop dedupe for traffic the set has room
                // for — which is what a backwards clock step produced, since
                // a stale stamp can sit ahead of the head-walk's stopping
                // point and outlive its own window.
                dropExpired(now);
            }
            if (seenAt.size >= maxTracked) {
                if (!warnedAtBudget) {
                    warnedAtBudget = true;
                    log.warn(`[dedupe] tracking budget reached (${maxTracked}); new ids are no longer recorded`);
                }
                return false;
            }
            seenAt.set(key, now);
            return false;
        },
        size: () => seenAt.size,
    };
}

/**
 * Distinct deliveries tracked at once.
 *
 * Reaching this is an anomaly, not routine: a single user's channel traffic is
 * bounded by how fast a person types. Sized so a busy workspace never sees it
 * while a flood cannot walk memory upward without limit.
 */
const MAX_TRACKED_DELIVERIES = 50_000;

/**
 * Ten minutes covers a vendor's retry horizon with room to spare, without
 * holding ids long enough for the map to matter.
 */
export const DELIVERY_DEDUPE_TTL_MS = 10 * 60 * 1000;
