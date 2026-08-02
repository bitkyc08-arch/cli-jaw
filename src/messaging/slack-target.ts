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
    options: { threadTs?: string; teamId?: string } = {},
): RemoteTarget {
    const target: RemoteTarget = {
        channel: 'slack',
        targetKind: slackTargetKind(conversationId),
        peerKind: slackPeerKind(conversationId),
        targetId: conversationId,
    };
    if (options.threadTs) target.threadId = options.threadTs;
    if (options.teamId) target.guildId = options.teamId;
    return target;
}

/**
 * Resolve the thread_ts to reply into.
 * Slack requires the PARENT message ts — never a reply's own ts. A top-level
 * message has no thread_ts, so its own ts becomes the parent of a new thread.
 */
export function resolveSlackThreadTs(
    event: { ts?: string; thread_ts?: string },
    replyInThread: boolean,
): string | undefined {
    if (!replyInThread) return event.thread_ts;
    return event.thread_ts || event.ts;
}
