// Channel-neutral remote command identity (M4-A0).
//
// Transports still call `makeCommandCtx` + `executeCommand` this cycle. This
// module only names the five fields a later handler will need so Discord slash,
// Slack slash, and Telegram text cannot invent three shapes for the same fact.

import type { MessengerChannel } from './types.js';

export type RemoteCommandContext = {
    channel: MessengerChannel;
    actorId: string;
    conversationKey: string;
    chatSessionId: string;
    generation: number;
};

export type RemoteCommandContextInput = {
    channel: MessengerChannel;
    actorId?: string;
    conversationKey?: string;
    chatSessionId?: string;
    generation?: number;
};

export type RemoteCommandContextResult =
    | { ok: true; context: RemoteCommandContext }
    | { ok: false; reason: 'missing_field'; field: keyof RemoteCommandContext };

const CHANNELS = new Set<MessengerChannel>(['telegram', 'discord', 'slack']);

export function resolveRemoteCommandContext(
    input: RemoteCommandContextInput,
): RemoteCommandContextResult {
    if (!CHANNELS.has(input.channel)) return { ok: false, reason: 'missing_field', field: 'channel' };
    if (!input.actorId) return { ok: false, reason: 'missing_field', field: 'actorId' };
    if (!input.conversationKey) return { ok: false, reason: 'missing_field', field: 'conversationKey' };
    if (!input.chatSessionId) return { ok: false, reason: 'missing_field', field: 'chatSessionId' };
    if (typeof input.generation !== 'number' || !Number.isInteger(input.generation) || input.generation < 0) {
        return { ok: false, reason: 'missing_field', field: 'generation' };
    }
    return {
        ok: true,
        context: {
            channel: input.channel,
            actorId: input.actorId,
            conversationKey: input.conversationKey,
            chatSessionId: input.chatSessionId,
            generation: input.generation,
        },
    };
}
