// Structural channel type helpers used by Discord wrappers.
//
// Discord.js has a complex union of channel types (TextChannel, ThreadChannel,
// DMChannel, partial channels, etc.). For our outbound use we only need:
//   - `send(payload)` for messages and attachments
//   - `sendTyping()` for typing indicators
//   - `parentId` for thread-channel allowlist matching
//
// A small structural type lets P03 narrow `channel as any` → typed access
// without taking a hard dependency on Discord.js's exact union shape.

export interface DiscordSendableChannel {
    send(payload: string | {
        content?: string;
        files?: Array<{ attachment: string; name: string }>;
    }): Promise<unknown>;
}

export interface DiscordTypingChannel {
    sendTyping?: () => Promise<unknown>;
}

export interface DiscordThreadLikeChannel {
    parentId?: string | null;
}

export function isSendableChannel(channel: unknown): channel is DiscordSendableChannel {
    return !!channel && typeof (channel as { send?: unknown }).send === 'function';
}

function isChannelObject(channel: unknown): channel is Record<string, unknown> {
    return !!channel && typeof channel === 'object';
}

export function asChannelWith<K extends string>(channel: unknown, key: K): (Record<K, unknown> & object) | null {
    return isChannelObject(channel) && key in channel ? channel as Record<K, unknown> & object : null;
}

export function asSendable(channel: unknown): DiscordSendableChannel | null {
    return isSendableChannel(channel) ? channel : null;
}

export function asTypingChannel(channel: unknown): DiscordTypingChannel | null {
    const narrowed = asChannelWith(channel, 'sendTyping');
    return narrowed && typeof narrowed.sendTyping === 'function' ? narrowed as DiscordTypingChannel : null;
}

export function asThreadLike(channel: unknown): DiscordThreadLikeChannel | null {
    return asChannelWith(channel, 'parentId') as DiscordThreadLikeChannel | null;
}
