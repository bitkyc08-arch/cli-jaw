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

/** What each transport can promise about when an inbound event is acknowledged.
 *  This is an observation of the transport, not a policy knob: Slack's Socket Mode
 *  requires an ACK before work, Telegram's offset advances only after final
 *  delivery, and Discord's gateway ACK is not under this process's control. */
export type IngressAckPolicy =
    | 'transport-first'
    | 'after-durable-append'
    | 'after-final-delivery'
    | 'transport-managed';

export const INGRESS_ACK_POLICIES = new Set<IngressAckPolicy>([
    'transport-first',
    'after-durable-append',
    'after-final-delivery',
    'transport-managed',
]);

/** One inbound event, normalized. Vendor `Context`, `Message` and `SlackEnvelope`
 *  stop here: past this boundary the core sees only these fields.
 *
 *  `accountId` and `target` are required on purpose. Without the account the ingress
 *  journal cannot namespace an event key, and without the target the core would have
 *  to re-derive per vendor where a reply goes. */
export type InboundEnvelope = {
    channel: MessengerChannel;
    accountId: string;
    eventId: string;
    conversationKey: string;
    threadKey?: string;
    actorId: string;
    receivedAt: number;
    ackPolicy: IngressAckPolicy;
    /** Opaque correlation handle for logs and traces. Never a token, body or URL. */
    rawEnvelopeRef?: string;
    target: RemoteTarget;
};

/** Operations an adapter can be asked to perform. Shares its axis with the
 *  capability key set: one operation, one capability. */
export type ChannelOperation =
    | 'sendText'
    | 'editText'
    | 'deleteMessage'
    | 'reaction'
    | 'typing'
    | 'fileUpload'
    | 'voice'
    | 'interactiveActions';

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

/** Validate a normalized inbound event before it becomes ingress authority.
 *  Reaching this with an empty accountId is a contract violation, not a runtime
 *  condition: each transport refuses to start, or drops the message, before here. */
export function isInboundEnvelope(value: unknown): value is InboundEnvelope {
    if (!value || typeof value !== 'object') return false;
    const envelope = value as Record<string, unknown>;
    if (!isMessengerChannel(envelope['channel'])) return false;
    if (typeof envelope['accountId'] !== 'string' || !envelope['accountId'].trim()) return false;
    if (typeof envelope['eventId'] !== 'string' || !envelope['eventId']) return false;
    if (typeof envelope['conversationKey'] !== 'string' || !envelope['conversationKey']) return false;
    if (typeof envelope['actorId'] !== 'string' || !envelope['actorId']) return false;
    if (typeof envelope['receivedAt'] !== 'number' || !Number.isFinite(envelope['receivedAt'])) return false;
    if (!INGRESS_ACK_POLICIES.has(envelope['ackPolicy'] as IngressAckPolicy)) return false;
    if (envelope['threadKey'] != null && typeof envelope['threadKey'] !== 'string') return false;
    if (envelope['rawEnvelopeRef'] != null && typeof envelope['rawEnvelopeRef'] !== 'string') return false;
    if (!isRemoteTarget(envelope['target'])) return false;
    // A target from another channel would route the reply somewhere the message
    // never came from — the exact failure origin-binding exists to prevent.
    return (envelope['target'] as RemoteTarget).channel === envelope['channel'];
}
