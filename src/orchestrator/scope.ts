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

// Local execution scopes stay dormant until the no-native-state guard lands.
// Remote scopes are already isolated and continue to use the canonical helper.
export const LOCAL_SESSION_SCOPE_ACTIVATION = false;

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
    return `local:${sessionId}`;
}

export function resolveOrcScope(input: OrcScopeInput = {}): string {
    const remoteKey = input.persistedScopeId || (input.target ? buildRemoteBindingKey(input.target) : undefined);
    const sessionId = input.chatSessionId || remoteKey || 'default';
    return scopeForChatSession(sessionId, remoteKey, input.multiSessionEnabled === true);
}

export function findActiveScope(_origin: string, _chatId?: string | number, _meta?: { workingDir?: string }): string | null {
    return 'default';
}
