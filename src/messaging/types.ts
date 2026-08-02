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

// targetId is always string. Legacy number chatIds are String()-converted at ingest.
