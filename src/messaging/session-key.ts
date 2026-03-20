// ─── Session Key + Queue Grouping ────────────────────
// Deterministic session key from RemoteTarget for queue fairness and reply routing.

import type { RemoteTarget, RuntimeOrigin } from './types.js';

/**
 * Build a deterministic session key from a RemoteTarget.
 * Format: `<channel>:<peerKind>:<targetKind>:<targetId>[:topic|thread:<threadId>]`
 */
export function buildRemoteSessionKey(target: RemoteTarget): string {
    const base = `${target.channel}:${target.peerKind}:${target.targetKind}:${target.targetId}`;
    if (target.threadId) {
        const suffix = target.channel === 'telegram' ? 'topic' : 'thread';
        return `${base}:${suffix}:${target.threadId}`;
    }
    return base;
}

/**
 * Build a queue grouping key for message batching.
 * Non-remote origins (web, cli) use origin alone.
 * Remote origins use the full session key for fair queuing.
 */
export function groupQueueKey(origin: RuntimeOrigin, target?: RemoteTarget): string {
    if (!target) return origin;
    return `${origin}:${buildRemoteSessionKey(target)}`;
}
