// ─── Session Key + Queue Grouping ────────────────────
// Deterministic session key from RemoteTarget for queue fairness and reply routing.

import type { RemoteTarget, RuntimeOrigin } from './types.js';

export interface SessionScope { scope: string; chatSessionId: string }

/** Normalize transport-specific thread identifiers before key construction. */
export function normalizedThreadId(target?: Pick<RemoteTarget, 'channel' | 'threadId'>): string | undefined {
    if (!target?.threadId) return undefined;
    return target.channel === 'telegram' && Number(target.threadId) <= 1
        ? undefined
        : target.threadId;
}

/**
 * Build a deterministic session key from a RemoteTarget.
 * Format: `<channel>:<peerKind>:<targetKind>:<targetId>[:topic|thread:<threadId>]`
 */
export function buildRemoteSessionKey(target: RemoteTarget): string {
    const base = `${target.channel}:${target.peerKind}:${target.targetKind}:${target.targetId}`;
    const threadId = normalizedThreadId(target);
    if (threadId) {
        const suffix = target.channel === 'telegram' ? 'topic' : 'thread';
        return `${base}:${suffix}:${threadId}`;
    }
    return base;
}

/**
 * Build the canonical persistent binding key for a remote conversation.
 * Format: `jaw:<origin>:<kind>:<id>[:thread:<tid>]`
 */
export function buildRemoteBindingKey(target: RemoteTarget): string {
    const part = (value: string) => encodeURIComponent(value);
    const base = `jaw:${part(target.channel)}:${part(target.peerKind)}:${part(target.targetId)}`;
    const threadId = normalizedThreadId(target);
    return threadId ? `${base}:thread:${part(threadId)}` : base;
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
