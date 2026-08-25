// ─── Messaging Send ──────────────────────────────────
// Unified outbound message routing for all channels.

import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { assertSendFilePath } from '../security/path-guards.js';
import { isRemoteTarget, type MessengerChannel, type OutboundType, type RemoteTarget } from './types.js';
import { getLastActiveTarget, getLatestSeenTarget, clearTargetState, getHomeChannel } from './runtime.js';
import { slackTargetFromId, slackPeerKind } from './slack-target.js';
import { readSlackAllowlist, MALFORMED_SLACK_ALLOWLIST } from '../slack/events.js';
import { buildRemoteBindingKey } from './session-key.js';
import { getRemoteBoundSessionId } from '../core/chat-sessions.js';
import { applyOutputPolicy } from '../core/policy-hooks.js';
import { redactChannelSecrets } from './redact.js';
import { log } from '../core/logger.js';

export function stampOutboundSend(channel: MessengerChannel, ok: boolean): void {
    log.event('outbound.send', { channel, result: ok ? 'ok' : 'error' });
}

/**
 * The outbound side of the same allowlist the inbound gate reads.
 *
 * Reading the raw array here was its own disagreement: the gate refused every
 * channel on a malformed value while `validateTarget` saw `undefined.length`,
 * treated it as "nothing configured", and let an explicit target through. One
 * reader, one verdict (#406).
 */
function slackAllowlist(): { ids: string[]; malformed: boolean } {
    const ids = readSlackAllowlist(settings["slack"]?.channelIds);
    const malformed = ids.length === 1 && ids[0] === MALFORMED_SLACK_ALLOWLIST;
    return { ids, malformed };
}

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
    /** Opt in to a lesser delivery when the channel cannot render the requested
     *  fidelity. Absent means the caller would rather be told it is unsupported
     *  than have the message quietly arrive as something else. */
    interactiveFallback?: 'text';
    /** Non-interactive senders (heartbeats, scheduled jobs) set this to false so a
     *  missing target FAILS instead of silently resolving to whoever spoke last.
     *  The last-active chain exists for CONVERSATIONAL replies where "this
     *  conversation" is the obvious destination (#397); a scheduled report has no
     *  such context, so inheriting one delivers it to an unrelated thread (#437).
     *  Absent keeps the historical behaviour — every existing caller is unchanged. */
    allowActiveFallback?: boolean;
    /** Skip the two volatile slots and resolve straight to the configured
     *  allowlist. For reminders, watcher notifications and alerts, which have a
     *  destination in the operator sense (the channel that was set up to receive
     *  them) but not a conversational one — so last-active is wrong while failing
     *  outright would be worse than delivering somewhere stable (#438). */
    preferConfiguredTarget?: boolean;
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

function badRequest(code: string, message = code): Error & { statusCode: number; code: string } {
    return Object.assign(new Error(message), { statusCode: 400, code });
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

function normalizeInteractiveFallback(value: unknown): 'text' | undefined {
    if (value == null || value === '') return undefined;
    const fallback = String(value).trim().toLowerCase();
    // Only one lesser delivery exists today. Accepting anything else would let a
    // typo read as consent to a downgrade the caller did not ask for.
    if (fallback !== 'text') throw badRequest('invalid_interactive_fallback');
    return 'text';
}

function normalizeChannel(value: unknown): MessengerChannel | 'active' {
    const channel = value == null || value === ''
        ? 'active'
        : String(value).trim().toLowerCase();
    if (!CHANNELS.has(channel as MessengerChannel | 'active')) {
        if (/^[CDG][A-Z0-9]+$/i.test(channel)) {
            throw badRequest(
                'invalid_channel',
                'invalid_channel: channel is a transport; use channel:"slack" with chat_id or target.targetId for a Slack conversation id',
            );
        }
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
        // This normalizer is an allowlist, so an opt-in the caller sent would be
        // dropped here and every HTTP keyboard send to a channel without
        // interactive support would come back unsupported.
        interactiveFallback: normalizeInteractiveFallback(
            body["interactive_fallback"] ?? body["interactiveFallback"],
        ),
    });
}

// ─── Resolve Target ─────────────────────────────────

function resolveChannel(req: ChannelSendRequest): MessengerChannel {
    if (req.target) {
        if (req.channel && req.channel !== 'active' && req.channel !== req.target.channel) {
            throw badRequest('channel_target_mismatch');
        }
        return req.target.channel;
    }
    if (req.channel && req.channel !== 'active') return req.channel;
    return getHomeChannel();
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
        // A sentinel is not a conversation. Falling back to it would address a
        // channel that does not exist; falling back to the raw first element of
        // an unreadable list would address whatever happened to be there (#406).
        const { ids, malformed } = slackAllowlist();
        if (!malformed && ids.length) {
            return slackTargetFromId(String(ids[0]));
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
    if (!isRemoteTarget(target)) return false;
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
        // Through the gate's reader, so a malformed list denies here too instead
        // of reading as "nothing configured" and admitting any target (#406).
        const { ids: allowed } = slackAllowlist();
        if (allowed.length && !allowed.includes(target.targetId)) return false;
        if (!allowed.length && options.requireConfiguredAllowlist) return false;
    }
    return true;
}

export function targetFromChatId(channel: MessengerChannel, chatId: string | number): RemoteTarget {
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

function sameSlackDestination(explicit: RemoteTarget, known: RemoteTarget): boolean {
    if (!isRemoteTarget(known) || known.channel !== 'slack') return false;
    if (!validateTarget(known, 'slack')) return false;
    if (explicit.targetId !== known.targetId) return false;
    if (explicit.threadId != null && explicit.threadId !== known.threadId) return false;
    return true;
}

/**
 * Does this conversation already own a chat session?
 *
 * A binding is written when the bot is addressed in a conversation, so its presence
 * is evidence the bot belongs there — the same evidence the last-active slot carries,
 * except it does not move when a different conversation speaks.
 *
 * The lookup is read-only on purpose: authorizing a send must never CREATE the
 * binding that authorizes it.
 */
function isRemoteBoundConversation(target: RemoteTarget): boolean {
    try {
        return getRemoteBoundSessionId(buildRemoteBindingKey(target)) !== null;
    } catch {
        // No database (CLI paths, tests without a home) simply means no evidence.
        return false;
    }
}

function authorizeExplicitTarget(target: RemoteTarget, channel: MessengerChannel): RemoteTarget | null {
    if (!isRemoteTarget(target) || target.channel !== channel) return null;
    if (validateTarget(target, channel, { requireConfiguredAllowlist: true })) return target;
    // Same reading again: an unreadable allowlist is a configured one for this
    // purpose, so the vouching path below stays closed rather than standing in
    // for a list nobody can parse (#406).
    if (channel !== 'slack' || slackAllowlist().ids.length) return null;
    for (const known of [getLastActiveTarget('slack'), getLatestSeenTarget('slack')]) {
        if (known && sameSlackDestination(target, known)) {
            return target.threadId == null && known.threadId != null ? known : target;
        }
    }
    // With no configured allowlist, the two slots above are the only conversations
    // this process can vouch for — and both hold whatever spoke MOST RECENTLY. So an
    // agent that correctly addressed the channel it was actually working in got a 403
    // as soon as another channel messaged the bot, while omitting the target
    // succeeded and delivered to that other channel. The safe answer was rejected and
    // the unsafe one accepted, which is why the prompt learned to omit it (#397).
    //
    // A conversation the bot is bound to is equally vouched for, and unlike the slots
    // it does not change when someone else talks. Binding requires the bot to have
    // been addressed there, so this widens nothing an allowlist would have closed;
    // with a configured allowlist we never reach this line at all.
    if (isRemoteBoundConversation(target)) return target;
    return null;
}

export async function sendChannelOutput(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const channel = resolveChannel(req);

    if (!OUTBOUND_TYPES.has(req.type)) {
        return { ok: false, status: 400, error: `Invalid outbound type: ${String(req.type)}` };
    }

    if (req.chatId != null && String(req.chatId).trim()) {
        const explicitTarget = targetFromChatId(channel, req.chatId);
        if (req.target && (req.target.targetId !== explicitTarget.targetId || req.target.channel !== explicitTarget.channel)) {
            return { ok: false, status: 400, error: 'chatId and target refer to different destinations' };
        }
        const authorized = authorizeExplicitTarget(req.target || explicitTarget, channel);
        if (!authorized) {
            return { ok: false, status: 403, error: `Explicit ${channel} chatId is not configured or the current active conversation` };
        }
        req.target = authorized;
    }

    // Validate explicit target (shape + allowlist)
    if (req.target) {
        const authorized = authorizeExplicitTarget(req.target, channel);
        if (!authorized) {
            return { ok: false, status: 403, error: `Invalid or disallowed target for ${channel}: ${req.target.targetId || '(empty)'}` };
        }
        req.target = authorized;
    }

    // Resolve target: explicit > validated lastActive > validated latestSeen > configured fallback > error
    //
    // Gated on allowActiveFallback: a scheduled sender opts OUT of this chain
    // entirely (#437). Without that opt-out a heartbeat with no target inherits
    // whichever conversation last spoke to the bot, which is how two reports
    // landed in an unrelated design thread on 2026-08-25.
    if (!req.target && req.allowActiveFallback !== false) {
        const configuredFirst = req.preferConfiguredTarget ? getConfiguredFallbackTarget(channel) : null;
        if (configuredFirst) req.target = configuredFirst;
        const last = req.target ? null : getLastActiveTarget(channel);
        if (last && validateTarget(last, channel)) {
            req.target = last;
        } else if (!req.target) {
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
    // Single choke point for every outbound send. A transport builds its error
    // string from a vendor SDK, and the Telegram Bot API puts the token in the
    // request URL — so the failure result is a credential sink, and it flows
    // straight into HTTP response bodies via res.json(result). Masking at each
    // call site was tried and missed several; masking here cannot be bypassed.
    const result = await sendFn(req);
    const sanitized = result.ok === false && typeof result.error === 'string'
        ? { ...result, error: redactChannelSecrets(result.error) }
        : result;
    stampOutboundSend(channel, sanitized.ok !== false);
    return sanitized;
}
