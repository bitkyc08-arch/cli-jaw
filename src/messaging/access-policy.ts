// Messaging access policy substrate (M4-A0).
//
// No production caller in this milestone — the same shape as the M3a journal
// before any transport imported it. M4-A1 is what will ask this module whether
// a remote actor may run /stop or /approve. Until then the tests are the only
// clients, and default-deny is the only safe unused default.

export type MessagingAccessMode = 'deny' | 'allowlist' | 'paired' | 'all';

export type MessagingAccessDecision = 'allow' | 'deny';

export type MessagingAccessRequest = {
    actorId: string;
    conversationKey: string;
    pairedActorId?: string;
    pairedConversationKey?: string;
};

export type MessagingAccessPolicy = {
    mode: MessagingAccessMode;
    allowlist?: readonly string[];
};

const DEFAULT_POLICY: MessagingAccessPolicy = { mode: 'deny' };

export function evaluateMessagingAccess(
    request: MessagingAccessRequest,
    policy: MessagingAccessPolicy = DEFAULT_POLICY,
): MessagingAccessDecision {
    if (!request.actorId || !request.conversationKey) return 'deny';
    switch (policy.mode) {
        case 'all':
            return 'allow';
        case 'allowlist':
            return policy.allowlist?.includes(request.actorId) ? 'allow' : 'deny';
        case 'paired':
            return request.actorId === request.pairedActorId
                && request.conversationKey === request.pairedConversationKey
                ? 'allow'
                : 'deny';
        case 'deny':
        default:
            return 'deny';
    }
}
