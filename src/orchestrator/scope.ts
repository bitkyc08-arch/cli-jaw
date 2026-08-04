import type { RemoteTarget } from '../messaging/types.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import { settings } from '../core/config.js';

type OrcScopeInput = {
    origin?: string;
    target?: RemoteTarget;
    multiSessionEnabled?: boolean;
    chatId?: string | number;
    workingDir?: string | null;
    persistedScopeId?: string | null;
};

export function channelGateOn(channel: string | undefined): boolean {
    if (channel === 'slack') return settings["multiSession"]?.channels?.slack !== false;
    if (channel === 'telegram' || channel === 'discord') {
        return settings["multiSession"]?.channels?.[channel] === true;
    }
    return true;
}

export function resolveOrcScope(input: OrcScopeInput = {}): string {
    if (!input.multiSessionEnabled) return 'default';
    if (input.persistedScopeId) return input.persistedScopeId;
    if (input.target) return buildRemoteBindingKey(input.target);
    return 'default';
}

export function findActiveScope(_origin: string, _chatId?: string | number, _meta?: { workingDir?: string }): string | null {
    return 'default';
}
