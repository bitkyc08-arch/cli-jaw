import type { RemoteTarget } from '../messaging/types.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
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

// Only `local:` scopes get native-state isolation. Remote scopes such as
// `jaw:slack:...` already share a runtime bucket today, and cutting their resume
// here would break Slack sessions that work — that sharing belongs to unit 073.
export function isNativeStateIsolatedScope(scope: string | null | undefined): boolean {
    return typeof scope === 'string' && scope.startsWith(LOCAL_SESSION_SCOPE_PREFIX);
}

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
    if (!gateEnabled || sessionId === 'default') return 'default';
    if (remoteKey) return remoteKey;
    return `${LOCAL_SESSION_SCOPE_PREFIX}${sessionId}`;
}

export function resolveOrcScope(input: OrcScopeInput = {}): string {
    const remoteKey = input.persistedScopeId || (input.target ? buildRemoteBindingKey(input.target) : undefined);
    const sessionId = input.chatSessionId || remoteKey || 'default';
    return scopeForChatSession(sessionId, remoteKey, input.multiSessionEnabled === true);
}

export function findActiveScope(_origin: string, _chatId?: string | number, _meta?: { workingDir?: string }): string | null {
    return 'default';
}
