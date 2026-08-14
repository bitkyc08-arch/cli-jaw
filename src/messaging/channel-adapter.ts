// ─── Channel Adapter Contract ────────────────────────
// The closed port every messaging transport is reached through. It lists the whole
// callable surface: no method bag, no vendor client handed out, no capability
// inferred from object shape. A method whose capability is false still exists and
// answers with an `unsupported` receipt, so a caller can never probe
// `if (adapter.editText)` and get a different answer than the declaration gives.

import type { ChannelCapabilities } from './channel-capabilities.js';
import type { DeliveryReceipt } from './delivery-outcome.js';
import { unsupportedReceipt } from './delivery-outcome.js';
import type { TransportCapability } from './channel-health.js';
import type { TransportStartOutcome } from './runtime.js';
import type { ChannelOperation, MessengerChannel, RemoteTarget } from './types.js';

export type AdapterSendRequest = {
    target: RemoteTarget;
    text: string;
};

export type AdapterEditRequest = {
    target: RemoteTarget;
    platformMessageId: string;
    text: string;
};

export type AdapterDeleteRequest = {
    target: RemoteTarget;
    platformMessageId: string;
};

export type AdapterReactionRequest = {
    target: RemoteTarget;
    platformMessageId: string;
    emoji: string;
};

export type AdapterTypingRequest = {
    target: RemoteTarget;
};

export type AdapterFileRequest = {
    target: RemoteTarget;
    filePath: string;
    caption?: string;
};

export type AdapterInteractiveRequest = {
    target: RemoteTarget;
    text: string;
    actions: unknown;
    /** Opt-in lesser delivery when the channel cannot render actions. Absent means
     *  the caller would rather get `unsupported` than a silently degraded message. */
    fallback?: 'text';
};

export interface ChannelAdapter {
    readonly channel: MessengerChannel;
    readonly capabilities: ChannelCapabilities;
    /** The transport account this adapter speaks for. Namespaces every ingress key. */
    readonly accountId: string;
    /** Accepted, not necessarily receiving yet. Readiness is reported by health(). */
    start(): Promise<TransportStartOutcome>;
    stop(): Promise<void>;
    /** Live transport state only. Settings-derived reporting stays in channel-health,
     *  which must still describe a channel that has no adapter at all. */
    health(): TransportCapability;
    sendText(request: AdapterSendRequest): Promise<DeliveryReceipt>;
    editText(request: AdapterEditRequest): Promise<DeliveryReceipt>;
    deleteMessage(request: AdapterDeleteRequest): Promise<DeliveryReceipt>;
    addReaction(request: AdapterReactionRequest): Promise<DeliveryReceipt>;
    setTyping(request: AdapterTypingRequest): Promise<DeliveryReceipt>;
    uploadFile(request: AdapterFileRequest): Promise<DeliveryReceipt>;
    sendVoice(request: AdapterFileRequest): Promise<DeliveryReceipt>;
    sendInteractive(request: AdapterInteractiveRequest): Promise<DeliveryReceipt>;
}

/** Dependencies an adapter would otherwise construct for itself. Production passes
 *  nothing; the conformance suite passes fixtures and runs the same adapter code. */
export type ChannelAdapterDeps = Record<string, unknown>;

/** Registered instead of an adapter instance so a disabled channel never imports its
 *  vendor SDK. discord.js alone costs ~48MB RSS at import. */
export type ChannelAdapterFactory = (deps?: ChannelAdapterDeps) => Promise<ChannelAdapter>;

/** Capability key -> operation. The key names a feature, the method names an action,
 *  and this is the one place that says which pairs with which. The conformance suite
 *  walks it, so a new capability without an operation fails there rather than drifting. */
export const CAPABILITY_OPERATIONS = {
    sendText: 'sendText',
    editText: 'editText',
    deleteMessage: 'deleteMessage',
    reaction: 'reaction',
    typing: 'typing',
    fileUpload: 'fileUpload',
    voice: 'voice',
    interactiveActions: 'interactiveActions',
} as const satisfies Record<string, ChannelOperation>;

export type OperationCapabilityKey = keyof typeof CAPABILITY_OPERATIONS;

/** Capability keys that describe a property rather than a callable operation. */
export const PROPERTY_CAPABILITY_KEYS = [
    'threads',
    'durableIngress',
    'replayableTransport',
    'maxMessageChars',
] as const;

/** Adapter method for each operation capability. Lets a test call the real method
 *  from the declaration instead of hand-maintaining a second list. */
export const CAPABILITY_METHODS = {
    sendText: 'sendText',
    editText: 'editText',
    deleteMessage: 'deleteMessage',
    reaction: 'addReaction',
    typing: 'setTyping',
    fileUpload: 'uploadFile',
    voice: 'sendVoice',
    interactiveActions: 'sendInteractive',
} as const satisfies Record<OperationCapabilityKey, keyof ChannelAdapter>;

/** Guard an operation against its own declaration. An adapter calls this first so a
 *  false capability can never reach a vendor request. */
export function refuseUndeclared(
    adapter: Pick<ChannelAdapter, 'channel' | 'accountId' | 'capabilities'>,
    key: OperationCapabilityKey,
): DeliveryReceipt | null {
    if (adapter.capabilities[key]) return null;
    return unsupportedReceipt(adapter.channel, adapter.accountId, CAPABILITY_OPERATIONS[key]);
}
