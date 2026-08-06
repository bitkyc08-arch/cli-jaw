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

/** Test hook: point the store at a temp file and drop the cache. */
export function resetThreadTrackerForTest(filePath?: string): void {
    threads = null;
    storePath = filePath ?? path.join(JAW_HOME, 'slack-threads.json');
}
