// ─── Slack Thread Participation Tracker ──────────────
// Which threads is the bot "in"? A thread counts as participated once the bot
// was mentioned in it (app_mention) or posted a reply into it. The mention
// gate consults this set so a conversation the user STARTED with a mention
// keeps flowing without re-mentioning the bot on every follow-up
// (Hermes thread_require_mention:false semantics).

// Persistence: JAW_HOME/slack-threads.json, written atomically (tmp+rename,
// same pattern as src/goal/store.ts). Restart survival matters here — losing
// the set silently turns every open thread back into "mention required",
// which reads as the bot ignoring the user mid-conversation.

import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from '../core/config.js';
import type { SessionOwnerToken } from '../agent/session-persistence.js';

/** Cap before trimming — matches Hermes' 500-entry tracker. */
export const SLACK_THREADS_CAP = 500;

let storePath = path.join(JAW_HOME, 'slack-threads.json');

/**
 * How the bot came to be in this thread.
 *
 * `owned` — the bot's own reply is the thread's parent, so the thread IS the
 * conversation with the bot and every follow-up is addressed to it.
 * `joined` — people were already talking and the bot was pulled in partway.
 * The rest of that conversation is still theirs, so it needs a mention.
 *
 * Collapsing the two is what made one mention hand the bot the whole thread
 * (#400): a live channel produced six replies to messages that named other
 * people entirely.
 */
export type ThreadParticipation = 'owned' | 'joined';

type ThreadRecord = { at: number; kind: ThreadParticipation };

// key = `${channel}:${threadTs}` → participation record. thread_ts values are
// only unique within a channel, so the channel is part of the key.
let threads: Map<string, ThreadRecord> | null = null;

export function threadKey(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
}

function load(): Map<string, ThreadRecord> {
    if (threads) return threads;
    threads = new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(raw)) {
                // A bare number is a record from before this file distinguished the
                // two cases. Which one it was is unknowable, so it reads as `joined`:
                // that asks for a mention the bot may not have needed, whereas
                // guessing `owned` would carry #400 forward for every existing user.
                if (typeof value === 'number') {
                    threads.set(key, { at: value, kind: 'joined' });
                } else if (value && typeof value === 'object') {
                    const record = value as Partial<ThreadRecord>;
                    if (typeof record.at === 'number') {
                        threads.set(key, {
                            at: record.at,
                            kind: record.kind === 'owned' ? 'owned' : 'joined',
                        });
                    }
                }
            }
        }
    } catch { /* missing or corrupt file = empty set; participation is re-earned */ }
    return threads;
}

function save(map: Map<string, ThreadRecord>): void {
    const tmp = storePath + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
        fs.renameSync(tmp, storePath);
    } catch (error) {
        // Tracking is a convenience; a failed write must never break inbound
        // handling. The in-memory set still works until the process exits.
        console.warn('[slack:threads] persist failed:', (error as Error).message);
    }
}

export function markThreadParticipated(
    channel: string,
    threadTs: string,
    kind: ThreadParticipation = 'joined',
): void {
    if (!channel || !threadTs) return;
    const map = load();
    const key = threadKey(channel, threadTs);
    const existing = map.get(key);
    const isNew = !existing;
    // Ownership is decided when the thread is first seen and never upgraded
    // afterwards. A reply the bot posts INTO someone else's thread is exactly
    // what `joined` describes, so letting that reply promote the thread to
    // `owned` would hand the bot the conversation it was only invited into.
    const kindToStore: ThreadParticipation = existing?.kind === 'owned' ? 'owned' : kind;
    map.set(key, { at: Date.now(), kind: kindToStore });
    let trimmed = false;
    if (map.size > SLACK_THREADS_CAP) {
        // Trim the least-recently-marked half, like Hermes' 500-cap tracker.
        // Sorted by stored timestamp, not Map insertion order, because
        // re-marking an existing key refreshes its value without moving it.
        const entries = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [staleKey] of entries.slice(0, Math.floor(map.size / 2))) {
            map.delete(staleKey);
        }
        trimmed = true;
    }
    // Persist on new participation, a kind change, or a cap trim; refreshing a
    // timestamp alone is not worth a disk write per thread reply.
    if (isNew || trimmed || existing?.kind !== kindToStore) save(map);
}

export function isThreadParticipated(channel: string, threadTs: string): boolean {
    if (!channel || !threadTs) return false;
    return load().has(threadKey(channel, threadTs));
}

/**
 * How the bot is in this thread, or null when it is not in it at all.
 *
 * The mention gate asks THIS rather than `isThreadParticipated`: presence alone
 * never meant the whole thread was addressed to the bot.
 */
export function threadParticipationKind(
    channel: string,
    threadTs: string,
): ThreadParticipation | null {
    if (!channel || !threadTs) return null;
    return load().get(threadKey(channel, threadTs))?.kind ?? null;
}

// ─── Prefetch claims ────────────────────────────────
// "Have I already injected this thread or channel's earlier messages?" is a DIFFERENT
// question from "may I reply in this thread?", and answering both from the
// participation set is what made the first-entry check unusable: app_mention
// marks participation before the ingress task even runs (bot.ts), so the check
// was a dead branch, while DM and listen-all channels mark only after a
// successful reply, so the same check raced.
//
// Deliberately in memory, not on disk: after a restart the agent session is gone
// too, so re-injecting the thread's history is the RIGHT behavior. Persisting
// the claim would leave a context-less session permanently without context.

type PrefetchClaim = { token: number; committed: boolean; lastUsed: number };
/** key -> current owner and whether history was actually injected. */
const prefetchClaimed = new Map<string, PrefetchClaim>();
const PREFETCH_CLAIM_CAP = 500;
let prefetchToken = 0;
let prefetchUse = 0;

function prefetchKey(channel: string, threadTs: string, owner: SessionOwnerToken): string {
    const subject = threadTs ? `thread:${threadTs}` : 'channel';
    return `${channel}:${subject}:${owner.global}:${owner.scope}`;
}

/**
 * Claim the one-time prefetch for a thread.
 *
 * Returns a token on success and 0 when the thread is already claimed.
 * Synchronous test-and-set: the caller runs it before any `await`, so two
 * envelopes arriving in the same tick cannot both win.
 *
 * The token exists because releasing is asynchronous. Without it a late
 * release from an abandoned attempt would delete whichever claim happened to
 * hold the key by then — the classic ABA: A claims, A times out and releases,
 * B claims, A's straggler releases B's claim, and the thread gets prefetched
 * twice.
 */
export function claimThreadPrefetch(
    channel: string, threadTs: string, owner: SessionOwnerToken,
): number {
    if (!channel) return 0;
    const key = prefetchKey(channel, threadTs, owner);
    const existing = prefetchClaimed.get(key);
    if (existing) {
        existing.lastUsed = ++prefetchUse;
        return 0;
    }
    if (prefetchClaimed.size >= PREFETCH_CLAIM_CAP) {
        // Active owners are singleflight locks, not cache entries. Evicting one
        // lets another envelope claim the same live thread and inject history
        // twice. Only completed claims may give ground under pressure.
        let removed = 0;
        const target = Math.floor(PREFETCH_CLAIM_CAP / 2);
        const completed = [...prefetchClaimed.entries()]
            .filter(([, claim]) => claim.committed)
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        for (const [stale] of completed) {
            prefetchClaimed.delete(stale);
            removed += 1;
            if (removed >= target) break;
        }
        // All bounded slots can legitimately be in flight. Decline rather than
        // queue or violate singleflight; a later message can retry after one
        // owner commits or releases.
        if (prefetchClaimed.size >= PREFETCH_CLAIM_CAP) return 0;
    }
    const token = ++prefetchToken;
    prefetchClaimed.set(key, { token, committed: false, lastUsed: ++prefetchUse });
    return token;
}

/** Mark that this owner actually injected history; completed claims are evictable. */
export function commitThreadPrefetch(
    channel: string, threadTs: string, owner: SessionOwnerToken, token: number,
): boolean {
    if (!channel || !token) return false;
    const claim = prefetchClaimed.get(prefetchKey(channel, threadTs, owner));
    if (!claim || claim.token !== token) return false;
    claim.committed = true;
    claim.lastUsed = ++prefetchUse;
    return true;
}

/**
 * Give a claim back when no history was actually injected.
 *
 * Without this a failed or skipped first attempt would silently consume the
 * thread's only chance: every later message would see the thread as already
 * prefetched and the agent would never receive the earlier conversation.
 *
 * Only the CURRENT owner may release. A stale token is a no-op.
 */
export function releaseThreadPrefetch(
    channel: string, threadTs: string, owner: SessionOwnerToken, token: number,
): void {
    if (!channel || !token) return;
    const key = prefetchKey(channel, threadTs, owner);
    if (prefetchClaimed.get(key)?.token !== token) return;
    prefetchClaimed.delete(key);
}

export function resetThreadPrefetchClaims(): void {
    prefetchClaimed.clear();
    prefetchToken = 0;
    prefetchUse = 0;
}

/** Test hook: point the store at a temp file and drop the cache. */
export function resetThreadTrackerForTest(filePath?: string): void {
    threads = null;
    storePath = filePath ?? path.join(JAW_HOME, 'slack-threads.json');
}
