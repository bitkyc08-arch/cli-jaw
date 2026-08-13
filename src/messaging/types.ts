// ─── Messaging Types ─────────────────────────────────
// Canonical type model for multi-channel messaging runtime.
// Phase 0 spec → Phase 1 implementation.

export type MessengerChannel = 'telegram' | 'discord' | 'slack';

export type RemotePeerKind = 'direct' | 'group' | 'channel';

export type RemoteTargetKind = 'user' | 'channel';

export type RemoteTarget = {
    channel: MessengerChannel;
    targetKind: RemoteTargetKind;
    peerKind: RemotePeerKind;
    targetId: string;
    threadId?: string;
    guildId?: string;
    parentTargetId?: string;
};

// Slack field mapping:
//   targetId        -> conversation id (C.../G.../D...) or user id (U...) pre-DM-open
//   threadId        -> thread_ts (the PARENT message ts) when replying in-thread
//   parentTargetId  -> unused (Slack threads live inside their conversation)
//   guildId         -> team id (T...) when known

export type RemoteInterface = MessengerChannel;

export type RuntimeOrigin = 'web' | 'cli' | 'system' | 'bgtask' | MessengerChannel;

export type OutboundType = 'text' | 'voice' | 'photo' | 'document' | 'keyboard';

export const MESSENGER_CHANNELS = new Set<MessengerChannel>(['telegram', 'discord', 'slack']);
const REMOTE_TARGET_KINDS = new Set<RemoteTargetKind>(['user', 'channel']);
const REMOTE_PEER_KINDS = new Set<RemotePeerKind>(['direct', 'group', 'channel']);

/** Validate persisted or network-derived target data before it becomes routing authority. */
export function isRemoteTarget(value: unknown): value is RemoteTarget {
    if (!value || typeof value !== 'object') return false;
    const target = value as Record<string, unknown>;
    if (!MESSENGER_CHANNELS.has(target['channel'] as MessengerChannel)) return false;
    if (!REMOTE_TARGET_KINDS.has(target['targetKind'] as RemoteTargetKind)) return false;
    if (!REMOTE_PEER_KINDS.has(target['peerKind'] as RemotePeerKind)) return false;
    if (typeof target['targetId'] !== 'string' || !target['targetId'].trim()) return false;
    for (const field of ['threadId', 'guildId', 'parentTargetId'] as const) {
        if (target[field] != null && typeof target[field] !== 'string') return false;
    }
    return true;
}

// targetId is always string. Legacy number chatIds are String()-converted at ingest.
export const isMessengerChannel = (value: unknown): value is MessengerChannel =>
    MESSENGER_CHANNELS.has(value as MessengerChannel);
