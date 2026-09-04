// ─── Slack Target Derivation ─────────────────────────
// Slack conversation ids are prefix-typed (docs.slack.dev conversations API):
//   C... public/private channel, G... legacy group or MPIM, D... IM (DM),
//   U... user (not a conversation — resolves to a DM via conversations.open)
// That prefix is the only signal needed to fill RemoteTarget's kind fields,
// so no API round-trip is required to classify a conversation.

import type { RemotePeerKind, RemoteTarget, RemoteTargetKind } from './types.js';

export function slackPeerKind(conversationId: string): RemotePeerKind {
    const prefix = conversationId.charAt(0).toUpperCase();
    // 'U' is a USER id, not a conversation. It resolves to a DM via
    // conversations.open, so it must classify as direct here — otherwise
    // validateTarget's channel-allowlist arm rejects it before the send
    // handler can open the DM.
    if (prefix === 'D' || prefix === 'U') return 'direct';
    if (prefix === 'G') return 'group';
    return 'channel';
}

export function slackTargetKind(conversationId: string): RemoteTargetKind {
    return slackPeerKind(conversationId) === 'direct' ? 'user' : 'channel';
}

export function slackTargetFromId(
    conversationId: string,
    options: { threadTs?: string; teamId?: string; threadIsSynthetic?: boolean } = {},
): RemoteTarget {
    const target: RemoteTarget = {
        channel: 'slack',
        targetKind: slackTargetKind(conversationId),
        peerKind: slackPeerKind(conversationId),
        targetId: conversationId,
    };
    if (options.threadTs) target.threadId = options.threadTs;
    // Only meaningful alongside a threadTs: it says that ts names a message, not
    // an existing thread, so the session key must not use it (#520).
    if (options.threadTs && options.threadIsSynthetic) target.threadIsSynthetic = true;
    if (options.teamId) target.guildId = options.teamId;
    return target;
}

/**
 * Resolve the thread_ts to reply into.
 * Slack requires the PARENT message ts — never a reply's own ts. A top-level
 * message has no thread_ts, so its own ts becomes the parent of a new thread.
 *
 * `replyInThread: false` means "post at conversation top level", so it returns
 * undefined even for an inbound message that itself arrived inside a thread.
 * Returning the inbound thread_ts there would keep every reply threaded and
 * make the setting a no-op for exactly the case it exists to control.
 */
export function resolveSlackThreadTs(
    event: { ts?: string; thread_ts?: string },
    replyInThread: boolean,
): string | undefined {
    if (!replyInThread) return undefined;
    return event.thread_ts || event.ts;
}

/** The same resolution, with the two concerns kept apart.
 *
 *  `threadTs` is where a reply goes. `synthetic` says the thread does not exist
 *  yet, so the SESSION key must fall back to the conversation. Returning one
 *  value for both is what made every top-level message its own session (#520):
 *  the reply address and the conversation identity are not the same question. */
export function resolveSlackThreadPlacement(
    event: { ts?: string; thread_ts?: string },
    replyInThread: boolean,
): { threadTs?: string; synthetic: boolean } {
    if (!replyInThread) return { synthetic: false };
    if (event.thread_ts) return { threadTs: event.thread_ts, synthetic: false };
    return { ...(event.ts ? { threadTs: event.ts } : {}), synthetic: Boolean(event.ts) };
}
