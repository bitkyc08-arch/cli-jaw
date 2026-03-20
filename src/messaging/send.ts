// ─── Messaging Send ──────────────────────────────────
// Unified outbound message routing for all channels.

import { settings } from '../core/config.js';
import type { MessengerChannel, OutboundType, RemoteTarget } from './types.js';
import { getLastActiveTarget, getLatestSeenTarget } from './runtime.js';

// ─── Request Model ──────────────────────────────────

export type ChannelSendRequest = {
    channel?: MessengerChannel | 'active';
    type: OutboundType;
    text?: string;
    filePath?: string;
    caption?: string;
    target?: RemoteTarget;
    chatId?: string | number;
};

// ─── Transport Send Registry ────────────────────────

type TransportSendFn = (req: ChannelSendRequest) => Promise<{ ok: boolean; error?: string; [k: string]: any }>;

const sendFns = new Map<MessengerChannel, TransportSendFn>();

export function registerSendTransport(channel: MessengerChannel, fn: TransportSendFn) {
    sendFns.set(channel, fn);
}

// ─── Normalize ──────────────────────────────────────

export function normalizeChannelSendRequest(body: Record<string, any>): ChannelSendRequest {
    return {
        channel: body.channel || 'active',
        type: (body.type || 'text') as OutboundType,
        text: body.text,
        filePath: body.file_path || body.filePath,
        caption: body.caption,
        chatId: body.chat_id || body.chatId,
    };
}

// ─── Resolve Target ─────────────────────────────────

function resolveChannel(req: ChannelSendRequest): MessengerChannel {
    if (req.channel && req.channel !== 'active') return req.channel;
    return (settings.channel as MessengerChannel) || 'telegram';
}

// ─── Send ───────────────────────────────────────────

export async function sendChannelOutput(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: any }> {
    const channel = resolveChannel(req);

    // Resolve target: explicit > lastActive > latestSeen
    if (!req.target) {
        const last = getLastActiveTarget(channel);
        if (last) req.target = last;
        else {
            const seen = getLatestSeenTarget(channel);
            if (seen) req.target = seen;
        }
    }

    const sendFn = sendFns.get(channel);
    if (!sendFn) {
        return { ok: false, error: `No send transport registered for ${channel}` };
    }

    return sendFn(req);
}
