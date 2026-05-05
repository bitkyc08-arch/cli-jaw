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
