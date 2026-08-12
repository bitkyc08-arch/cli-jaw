import type { MessengerChannel } from './types.js';

export interface ChannelCapabilities {
    readonly editMessages: boolean;
    readonly threads: boolean;
    readonly interactiveComponents: boolean;
    readonly fileUpload: boolean;
    readonly durableOffset: boolean;
    readonly maxMessageChars: number;
}

const CAPABILITIES = {
    telegram: {
        editMessages: true,
        threads: true,
        interactiveComponents: true,
        fileUpload: true,
        durableOffset: false,
        maxMessageChars: 32_000,
    },
    discord: {
        editMessages: true,
        threads: true,
        interactiveComponents: true,
        fileUpload: true,
        durableOffset: false,
        maxMessageChars: 2_000,
    },
    slack: {
        editMessages: true,
        threads: true,
        interactiveComponents: true,
        fileUpload: true,
        durableOffset: false,
        maxMessageChars: 3_900,
    },
} as const satisfies Record<MessengerChannel, ChannelCapabilities>;

export function capabilitiesFor(channel: MessengerChannel): ChannelCapabilities {
    return CAPABILITIES[channel];
}
