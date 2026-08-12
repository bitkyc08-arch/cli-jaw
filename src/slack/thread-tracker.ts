// ─── Slack Thread Participation Tracker ──────────────
// Which threads is the bot "in"? A thread counts as participated once the bot
// was mentioned in it (app_mention) or posted a reply into it. The mention
// gate consults this set so a conversation the user STARTED with a mention
// keeps flowing without re-mentioning the bot on every follow-up
// (Hermes thread_require_mention:false semantics — devlog
// 260806_slack_thread_dynamic_lookup/001 §1).
//
// Persistence: JAW_HOME/slack-threads.json, written atomically (tmp+rename,
// same pattern as src/goal/store.ts). Restart survival matters here — losing
// the set silently turns every open thread back into "mention required",
// which reads as the bot ignoring the user mid-conversation.

import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from '../core/config.js';

/** Cap before trimming — matches Hermes' 500-entry tracker. */
export const SLACK_THREADS_CAP = 500;

let storePath = path.join(JAW_HOME, 'slack-threads.json');
// key = `${channel}:${threadTs}` → last-marked epoch ms. thread_ts values are
// only unique within a channel, so the channel is part of the key.
let threads: Map<string, number> | null = null;

export function threadKey(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
}

function load(): Map<string, number> {
    if (threads) return threads;
    threads = new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(raw)) {
                if (typeof value === 'number') threads.set(key, value);
            }
        }
    } catch { /* missing or corrupt file = empty set; participation is re-earned */ }
    return threads;
}

function save(map: Map<string, number>): void {
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

export function markThreadParticipated(channel: string, threadTs: string): void {
    if (!channel || !threadTs) return;
    const map = load();
    const key = threadKey(channel, threadTs);
    const isNew = !map.has(key);
    map.set(key, Date.now());
    let trimmed = false;
    if (map.size > SLACK_THREADS_CAP) {
        // Trim the least-recently-marked half, like Hermes' 500-cap tracker.
        // Sorted by stored timestamp, not Map insertion order, because
        // re-marking an existing key refreshes its value without moving it.
        const entries = [...map.entries()].sort((a, b) => a[1] - b[1]);
        for (const [staleKey] of entries.slice(0, Math.floor(map.size / 2))) {
            map.delete(staleKey);
        }
        trimmed = true;
    }
    // Persist on new participation or cap trim; refreshing a timestamp alone
    // is not worth a disk write per thread reply.
    if (isNew || trimmed) save(map);
}

export function isThreadParticipated(channel: string, threadTs: string): boolean {
    if (!channel || !threadTs) return false;
    return load().has(threadKey(channel, threadTs));
}

// ─── Prefetch claims ────────────────────────────────
// "Have I already injected this thread's earlier messages?" is a DIFFERENT
// question from "may I reply in this thread?", and answering both from the
// participation set is what made the first-entry check unusable: app_mention
// marks participation before the ingress task even runs (bot.ts), so the check
// was a dead branch, while DM and listen-all channels mark only after a
// successful reply, so the same check raced.
//
// Deliberately in memory, not on disk: after a restart the agent session is gone
// too, so re-injecting the thread's history is the RIGHT behavior. Persisting
// the claim would leave a context-less session permanently without context.

/** key -> the token of the claim currently holding it. */
const prefetchClaimed = new Map<string, number>();
const PREFETCH_CLAIM_CAP = 500;
let prefetchToken = 0;

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
export function claimThreadPrefetch(channel: string, threadTs: string): number {
    if (!channel || !threadTs) return 0;
    const key = threadKey(channel, threadTs);
    if (prefetchClaimed.has(key)) return 0;
    if (prefetchClaimed.size >= PREFETCH_CLAIM_CAP) {
        // Oldest half by insertion order — a claim is never refreshed, so
        // insertion order IS recency here.
        for (const [stale] of [...prefetchClaimed].slice(0, Math.floor(PREFETCH_CLAIM_CAP / 2))) {
            prefetchClaimed.delete(stale);
        }
    }
    const token = ++prefetchToken;
    prefetchClaimed.set(key, token);
    return token;
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
export function releaseThreadPrefetch(channel: string, threadTs: string, token: number): void {
    if (!channel || !threadTs || !token) return;
    const key = threadKey(channel, threadTs);
    if (prefetchClaimed.get(key) !== token) return;
    prefetchClaimed.delete(key);
}

export function resetThreadPrefetchClaims(): void {
    prefetchClaimed.clear();
    prefetchToken = 0;
}

/** Test hook: point the store at a temp file and drop the cache. */
export function resetThreadTrackerForTest(filePath?: string): void {
    threads = null;
    storePath = filePath ?? path.join(JAW_HOME, 'slack-threads.json');
}
