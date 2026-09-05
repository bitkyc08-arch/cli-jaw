import type { RemoteTarget } from '../messaging/types.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import type { SessionScope } from '../messaging/session-key.js';
import { settings } from '../core/config.js';

type OrcScopeInput = {
    origin?: string;
    target?: RemoteTarget;
    multiSessionEnabled?: boolean;
    chatSessionId?: string;
    chatId?: string | number;
    workingDir?: string | null;
    persistedScopeId?: string | null;
};

// Local execution scopes are live once the no-native-state guard below is in place.
// Remote scopes were already isolated and keep using the canonical helper.
export const LOCAL_SESSION_SCOPE_ACTIVATION = true;

export const LOCAL_SESSION_SCOPE_PREFIX = 'local:';

// 072 had an `isNativeStateIsolatedScope` here, used to decide which scopes must not
// touch the shared vendor state at all. 073 gave every scope a bucket of its own, so
// there is nothing left to isolate FROM and the predicate has no callers. It is removed
// rather than left behind, because a helper that describes a rule the code no longer
// follows is worse than no helper.
// A remote binding key, and only that, is a persistent binding between a remote
// conversation and a chat session. Local execution scopes look non-default too but bind
// nothing — treating them as remote writes a binding that hijacks the session (072 §1.2a).
export function isRemoteBindingScope(scope: string | null | undefined): boolean {
    return typeof scope === 'string' && scope.startsWith('jaw:');
}

export function channelGateOn(channel: string | undefined): boolean {
    if (channel === 'slack') return settings["multiSession"]?.channels?.slack !== false;
    if (channel === 'telegram' || channel === 'discord') {
        return settings["multiSession"]?.channels?.[channel] === true;
    }
    return true;
}

export function scopeForChatSession(
    sessionId: string,
    remoteKey?: string,
    gateEnabled = true,
): string {
    // `sessionId === 'default'` collapsing to 'default' EVEN WITH a remoteKey is a
    // deliberate contract, not an oversight (SSD-001a): the default session is the
    // shared one, and giving it a conversation-specific scope would bind the shared
    // session to one remote conversation. #399 is fixed where it is actually caused —
    // the queue resolving a missing chatSessionId to 'default' instead of to the
    // conversation's own binding — rather than by loosening this rule for everyone.
    if (!gateEnabled || sessionId === 'default') return 'default';
    if (remoteKey) return remoteKey;
    return `${LOCAL_SESSION_SCOPE_PREFIX}${sessionId}`;
}

export function resolveOrcScope(input: OrcScopeInput = {}): string {
    const remoteKey = input.persistedScopeId || (input.target ? buildRemoteBindingKey(input.target) : undefined);
    const sessionId = input.chatSessionId || remoteKey || 'default';
    return scopeForChatSession(sessionId, remoteKey, input.multiSessionEnabled === true);
}

/** Capture server placement once; the feature gate controls only automatic scope derivation. */
export function resolveExecutionBinding(input: OrcScopeInput & {
    scope?: string;
    captured?: SessionScope | null;
    activeChatSessionId: string;
}): Readonly<SessionScope> {
    // Untyped orchestration metadata must not silently turn a malformed explicit
    // identity into the shared default. Empty strings retain the existing fallback convention.
    for (const value of [input.scope, input.chatSessionId, input.captured?.scope,
        input.captured?.chatSessionId, input.activeChatSessionId]) {
        if (value !== undefined && typeof value !== 'string') {
            throw new TypeError('Execution binding identities must be strings');
        }
    }
    return Object.freeze({
        scope: input.scope || input.captured?.scope || resolveOrcScope(input),
        chatSessionId: input.chatSessionId || input.captured?.chatSessionId || input.activeChatSessionId || 'default',
    });
}

export function findActiveScope(_origin: string, _chatId?: string | number, _meta?: { workingDir?: string }): string | null {
    return 'default';
}
