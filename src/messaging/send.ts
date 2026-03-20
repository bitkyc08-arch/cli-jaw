// ─── Messaging Send ──────────────────────────────────
// Unified outbound message routing for all channels.

import { settings } from '../core/config.js';
import type { MessengerChannel, OutboundType, RemoteTarget } from './types.js';
import { getLastActiveTarget, getLatestSeenTarget, clearTargetState } from './runtime.js';

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
        target: body.target,
        chatId: body.chat_id || body.chatId,
    };
}

// ─── Resolve Target ─────────────────────────────────

function resolveChannel(req: ChannelSendRequest): MessengerChannel {
    if (req.channel && req.channel !== 'active') return req.channel;
    return (settings.channel as MessengerChannel) || 'telegram';
}

// ─── Send ───────────────────────────────────────────

/**
 * Resolve configured fallback target from settings.
 * Used when no lastActive or latestSeen target is available.
 */
function getConfiguredFallbackTarget(channel: MessengerChannel): RemoteTarget | null {
    if (channel === 'telegram') {
        const chatIds = settings.telegram?.allowedChatIds;
        if (chatIds?.length) {
            return {
                channel: 'telegram',
                targetKind: 'user',
                peerKind: 'direct',
                targetId: String(chatIds[0]),
            };
        }
    } else if (channel === 'discord') {
        const channelIds = settings.discord?.channelIds;
        if (channelIds?.length) {
            return {
                channel: 'discord',
                targetKind: 'channel',
                peerKind: 'channel',
                targetId: String(channelIds[0]),
            };
        }
    }
    return null;
}

/**
 * Validate a cached target against the current channel's configured allowlist.
 * Returns true if the target is valid for the given channel.
 */
export function validateTarget(target: RemoteTarget, channel: MessengerChannel): boolean {
    if (!target || !target.targetId) return false;
    if (target.channel !== channel) return false;
    if (channel === 'discord') {
        const allowed = settings.discord?.channelIds;
        if (allowed?.length) {
            // Allow if targetId or parentTargetId (for threads) is in channelIds
            const inAllowlist = allowed.includes(target.targetId)
                || (target.parentTargetId && allowed.includes(target.parentTargetId));
            if (!inAllowlist) return false;
        }
    } else if (channel === 'telegram') {
        const allowed = settings.telegram?.allowedChatIds;
        if (allowed?.length && !allowed.map(String).includes(String(target.targetId))) return false;
    }
    return true;
}

export async function sendChannelOutput(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: any }> {
    const channel = resolveChannel(req);

    // Validate explicit target shape (allow targets outside allowlist for direct API calls)
    if (req.target && (!req.target.targetId || !req.target.channel)) {
        return { ok: false, error: 'Invalid target: targetId and channel are required' };
    }

    // Resolve target: explicit > validated lastActive > validated latestSeen > configured fallback > error
    if (!req.target) {
        const last = getLastActiveTarget(channel);
        if (last && validateTarget(last, channel)) {
            req.target = last;
        } else {
            if (last) clearTargetState(channel); // stale cached target — clear it
            const seen = getLatestSeenTarget(channel);
            if (seen && validateTarget(seen, channel)) {
                req.target = seen;
            } else {
                const fallback = getConfiguredFallbackTarget(channel);
                if (fallback) req.target = fallback;
            }
        }
    }

    if (!req.target && !req.chatId) {
        return { ok: false, error: `No target available for ${channel} — send a message first or configure fallback IDs` };
    }

    const sendFn = sendFns.get(channel);
    if (!sendFn) {
        return { ok: false, error: `No send transport registered for ${channel}` };
    }

    return sendFn(req);
}
