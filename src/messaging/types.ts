// ─── Messaging Types ─────────────────────────────────
// Canonical type model for multi-channel messaging runtime.
// Phase 0 spec → Phase 1 implementation.

export type MessengerChannel = 'telegram' | 'discord';

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

export type RemoteInterface = MessengerChannel;

export type RuntimeOrigin = 'web' | 'cli' | 'system' | MessengerChannel;

export type OutboundType = 'text' | 'voice' | 'photo' | 'document';

// targetId is always string. Legacy number chatIds are String()-converted at ingest.
