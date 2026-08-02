// ─── Messaging Send ──────────────────────────────────
// Unified outbound message routing for all channels.

import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { assertSendFilePath } from '../security/path-guards.js';
import type { MessengerChannel, OutboundType, RemoteTarget } from './types.js';
import { getLastActiveTarget, getLatestSeenTarget, clearTargetState } from './runtime.js';
import { slackTargetFromId, slackPeerKind } from './slack-target.js';
import { applyOutputPolicy } from '../core/policy-hooks.js';

// ─── Request Model ──────────────────────────────────

export type ChannelSendRequest = {
    channel?: MessengerChannel | 'active';
    type: OutboundType;
    text?: string;
    filePath?: string;
    caption?: string;
    target?: RemoteTarget;
    chatId?: string | number;
    reply_markup?: unknown;
};

// ─── Transport Send Registry ────────────────────────

type TransportSendFn = (req: ChannelSendRequest) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;

const sendFns = new Map<MessengerChannel, TransportSendFn>();
const OUTBOUND_TYPES = new Set<OutboundType>(['text', 'voice', 'photo', 'document', 'keyboard']);
const CHANNELS = new Set<MessengerChannel | 'active'>(['telegram', 'discord', 'slack', 'active']);

export function registerSendTransport(channel: MessengerChannel, fn: TransportSendFn) {
    sendFns.set(channel, fn);
}

// ─── Normalize ──────────────────────────────────────

function badRequest(code: string): Error & { statusCode: number; code: string } {
    return Object.assign(new Error(code), { statusCode: 400, code });
}

function normalizeOutboundType(value: unknown): OutboundType {
    const type = value == null || value === ''
        ? 'text'
        : String(value).trim().toLowerCase();
    if (!OUTBOUND_TYPES.has(type as OutboundType)) {
        throw badRequest('invalid_outbound_type');
    }
    return type as OutboundType;
}

function normalizeChannel(value: unknown): MessengerChannel | 'active' {
    const channel = value == null || value === ''
        ? 'active'
        : String(value).trim().toLowerCase();
    if (!CHANNELS.has(channel as MessengerChannel | 'active')) {
        throw badRequest('invalid_channel');
    }
    return channel as MessengerChannel | 'active';
}

export function normalizeChannelSendRequest(body: Record<string, any>): ChannelSendRequest {
    const rawPath = body["file_path"] || body["filePath"];
    let filePath: string | undefined;
    if (rawPath) {
        filePath = assertSendFilePath(String(rawPath), settings["workingDir"] || undefined, settings["projectDirs"] || null);
    }
    return stripUndefined({
        channel: normalizeChannel(body["channel"]),
        type: normalizeOutboundType(body["type"]),
        text: body["text"],
        filePath,
        caption: body["caption"],
        target: body["target"],
        chatId: body["chat_id"] ?? body["chatId"],
    });
}

// ─── Resolve Target ─────────────────────────────────

function resolveChannel(req: ChannelSendRequest): MessengerChannel {
    if (req.channel && req.channel !== 'active') return req.channel;
    return (settings["channel"] as MessengerChannel) || 'telegram';
}

// ─── Send ───────────────────────────────────────────

/**
 * Resolve configured fallback target from settings.
 * Used when no lastActive or latestSeen target is available.
 */
function getConfiguredFallbackTarget(channel: MessengerChannel): RemoteTarget | null {
    if (channel === 'telegram') {
        const chatIds = settings["telegram"]?.allowedChatIds;
        if (chatIds?.length) {
            return {
                channel: 'telegram',
                targetKind: 'user',
                peerKind: 'direct',
                targetId: String(chatIds[0]),
            };
        }
    } else if (channel === 'discord') {
        const channelIds = settings["discord"]?.channelIds;
        if (channelIds?.length) {
            return {
                channel: 'discord',
                targetKind: 'channel',
                peerKind: 'channel',
                targetId: String(channelIds[0]),
            };
        }
    } else if (channel === 'slack') {
        const channelIds = settings["slack"]?.channelIds;
        if (channelIds?.length) {
            return slackTargetFromId(String(channelIds[0]));
        }
    }
    return null;
}

/**
 * Validate a target against the current channel's configured allowlist.
 * Returns true if the target is valid for the given channel.
 */
export function validateTarget(
    target: RemoteTarget,
    channel: MessengerChannel,
    options: { requireConfiguredAllowlist?: boolean } = {},
): boolean {
    if (!target || !target.targetId) return false;
    if (target.channel !== channel) return false;
    if (channel === 'discord') {
        const allowed = settings["discord"]?.channelIds;
        if (allowed?.length) {
            // Allow if targetId or parentTargetId (for threads) is in channelIds
            const inAllowlist = allowed.includes(target.targetId)
                || (target.parentTargetId && allowed.includes(target.parentTargetId));
            if (!inAllowlist) return false;
        } else if (options.requireConfiguredAllowlist) {
            return false;
        }
    } else if (channel === 'telegram') {
        const allowed = settings["telegram"]?.allowedChatIds;
        if (allowed?.length && !allowed.map(String).includes(String(target.targetId))) return false;
        if (!allowed?.length && options.requireConfiguredAllowlist) return false;
    } else if (channel === 'slack') {
        // DMs are always permitted: a user messaging the bot directly is
        // self-authorizing, and D.../U... ids cannot be enumerated up front.
        //
        // The bypass is derived from the ID PREFIX, not from target.peerKind:
        // peerKind is caller-supplied metadata, so trusting it would let a
        // forged `{peerKind:'direct', targetId:'C999'}` evade the channel
        // allowlist entirely.
        if (slackPeerKind(target.targetId) === 'direct') return true;
        const allowed = settings["slack"]?.channelIds as string[] | undefined;
        if (allowed?.length && !allowed.includes(target.targetId)) return false;
        if (!allowed?.length && options.requireConfiguredAllowlist) return false;
    }
    return true;
}

function targetFromChatId(channel: MessengerChannel, chatId: string | number): RemoteTarget {
    const targetId = String(chatId);
    switch (channel) {
        case 'telegram':
            return { channel: 'telegram', targetKind: 'user', peerKind: 'direct', targetId };
        case 'slack':
            return slackTargetFromId(targetId);
        case 'discord':
        default:
            return { channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId };
    }
}

export function validateExplicitChatId(channel: MessengerChannel, chatId: string | number): boolean {
    return validateTarget(targetFromChatId(channel, chatId), channel, { requireConfiguredAllowlist: true });
}

export async function sendChannelOutput(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const channel = resolveChannel(req);

    if (!OUTBOUND_TYPES.has(req.type)) {
        return { ok: false, status: 400, error: `Invalid outbound type: ${String(req.type)}` };
    }

    if (req.chatId != null && String(req.chatId).trim()) {
        const explicitTarget = targetFromChatId(channel, req.chatId);
        if (!validateTarget(explicitTarget, channel, { requireConfiguredAllowlist: true })) {
            return { ok: false, status: 403, error: `Explicit ${channel} chatId is not in the configured allowlist` };
        }
        if (req.target && (req.target.targetId !== explicitTarget.targetId || req.target.channel !== explicitTarget.channel)) {
            return { ok: false, status: 400, error: 'chatId and target refer to different destinations' };
        }
        req.target = req.target || explicitTarget;
    }

    // Validate explicit target (shape + allowlist)
    if (req.target) {
        if (!validateTarget(req.target, channel, { requireConfiguredAllowlist: true })) {
            return { ok: false, status: 403, error: `Invalid or disallowed target for ${channel}: ${req.target.targetId || '(empty)'}` };
        }
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

    if (typeof req.text === 'string') {
        req.text = applyOutputPolicy(req.text, { scope: 'main', channel }).text;
    }
    return sendFn(req);
}
