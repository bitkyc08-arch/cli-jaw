import type { MessengerChannel } from './types.js';

/**
 * The closed capability set. Every key is either an operation an adapter can be
 * asked to perform, or an observable property of the transport. Adding a key here
 * is a contract change: the conformance suite asserts this exact shape, so a
 * channel cannot quietly grow or drop one.
 *
 * A `true` means the operation is callable in THIS tree today. That the vendor SDK
 * offers it is not evidence — three of these were true for that reason alone and
 * were wrong.
 */
export interface ChannelCapabilities {
    readonly sendText: boolean;
    readonly editText: boolean;
    readonly deleteMessage: boolean;
    readonly reaction: boolean;
    readonly typing: boolean;
    readonly fileUpload: boolean;
    /** Voice-file delivery, not a recording UI. */
    readonly voice: boolean;
    readonly threads: boolean;
    readonly interactiveActions: boolean;
    /** Inbound dedupe survives a process restart. */
    readonly durableIngress: boolean;
    /** The transport itself redelivers frames the process never acknowledged. */
    readonly replayableTransport: boolean;
    readonly maxMessageChars: number;
}

// Kept as literals rather than imported from the chunkers: this module is
// dependency-light on purpose, and importing src/discord/forwarder.ts would drag
// discord.js in behind it. `capability-limits.test.ts` asserts these against the
// constants the chunkers actually use, so the two cannot drift apart silently.
export const TELEGRAM_MAX_MESSAGE_CHARS = 32_000;
export const DISCORD_MAX_MESSAGE_CHARS = 2_000;
export const SLACK_MAX_MESSAGE_CHARS = 3_900;

const CAPABILITIES = {
    telegram: {
        sendText: true,
        editText: true,
        deleteMessage: true,
        // setMessageReaction is wired through src/telegram/reactions.ts and driven
        // by the inbound ACK handle in bot.ts (#413).
        reaction: true,
        typing: true,
        fileUpload: true,
        voice: true,
        threads: true,
        interactiveActions: true,
        durableIngress: true,
        replayableTransport: true,
        maxMessageChars: TELEGRAM_MAX_MESSAGE_CHARS,
    },
    discord: {
        sendText: true,
        editText: false,
        deleteMessage: false,
        reaction: false,
        typing: true,
        fileUpload: true,
        voice: true,
        threads: true,
        interactiveActions: false,
        durableIngress: true,
        replayableTransport: true,
        maxMessageChars: DISCORD_MAX_MESSAGE_CHARS,
    },
    slack: {
        sendText: true,
        editText: true,
        deleteMessage: true,
        // reactions.add / reactions.remove are wired through src/slack/api.ts and
        // driven by the inbound ACK handle in bot.ts (#412).
        reaction: true,
        typing: false,
        fileUpload: true,
        voice: true,
        threads: true,
        interactiveActions: false,
        durableIngress: true,
        replayableTransport: true,
        maxMessageChars: SLACK_MAX_MESSAGE_CHARS,
    },
} as const satisfies Record<MessengerChannel, ChannelCapabilities>;

/** Every key of the closed set, in declaration order. The conformance suite uses
 *  this to prove a channel declares all of them and nothing else. */
export const CHANNEL_CAPABILITY_KEYS = Object.keys(CAPABILITIES.telegram) as ReadonlyArray<keyof ChannelCapabilities>;

export function capabilitiesFor(channel: MessengerChannel): ChannelCapabilities {
    return CAPABILITIES[channel];
}

/** Read-only view for the matrix generator, which must not reach into module state. */
export function allChannelCapabilities(): Readonly<Record<MessengerChannel, ChannelCapabilities>> {
    return CAPABILITIES;
}
