// ─── Turn Conversation Address ───────────────────────
// The conversation an agent process is answering FOR, carried in that process's
// own environment.
//
// Why this exists: the two volatile slots (lastActive / latestSeen) hold ONE
// conversation per channel for the whole server, and every inbound message
// overwrites them. With multi-session on, a DM turn and a channel turn run
// concurrently, so by the time the DM's agent posts its answer the slot can
// already point at the channel that spoke in between — and a send with no
// explicit target lands in a PUBLIC conversation the user never addressed
// (#474).
//
// The address travels in the PER-TURN prompt and comes back on the send as
// `turn_conversation`. The obvious alternative — an environment variable on the
// agent process — is wrong here: `codex-app` leases pooled processes and the
// pool sets env only at CREATION, so a reused process would keep echoing the
// address of whichever turn first started it. That is the same misdelivery in a
// new shape, and with multi-session OFF every conversation shares one scope, so
// it would fire constantly.
//
// Nothing reads this from the server's own environment: the server process
// answers many conversations at once, so any single value there would be wrong
// for most of them.

import { isRemoteTarget, type MessengerChannel, type RemoteTarget } from './types.js';

/** Serialize a target for the turn prompt. Absent target = nothing to echo. */
export function encodeTurnConversation(target?: RemoteTarget): string | undefined {
    if (!isRemoteTarget(target)) return undefined;
    return JSON.stringify(target);
}

/**
 * Read a target back.
 *
 * Anything malformed reads as absent rather than throwing: a broken value must
 * degrade to today's behaviour, never take down the send path.
 */
export function decodeTurnConversation(raw: unknown): RemoteTarget | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return isRemoteTarget(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The echoed conversation, accepted only for `channel`.
 *
 * Channel-matched on purpose: a Slack turn must not supply the destination for
 * a Telegram send.
 */
export function turnConversationForChannel(
    target: RemoteTarget | null | undefined,
    channel: MessengerChannel,
): RemoteTarget | null {
    return target && target.channel === channel ? target : null;
}
