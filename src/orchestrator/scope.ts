import { settings } from '../core/config.js';
import type { RemoteTarget } from '../messaging/types.js';

type OrcScopeInput = {
    origin?: string;
    target?: RemoteTarget;
    chatId?: string | number;
    workingDir?: string | null;
    persistedScopeId?: string | null;
};

function normalizeRemoteKey(target?: RemoteTarget, chatId?: string | number): string {
    if (chatId !== undefined && chatId !== null) return String(chatId);
    if (!target) return 'default';
    if (typeof target === 'string') return target;
    return String(
        (target as Record<string, any>).channelId
        || (target as Record<string, any>).threadId
        || (target as Record<string, any>).id
        || 'default',
    );
}

export function resolveOrcScope(input: OrcScopeInput = {}): string {
    if (input.persistedScopeId) return String(input.persistedScopeId);

    const origin = String(input.origin || 'web').trim() || 'web';
    const workingDir = String(input.workingDir ?? settings.workingDir ?? '~').trim() || '~';

    if (origin === 'telegram' || origin === 'discord') {
        return `${origin}:${normalizeRemoteKey(input.target, input.chatId)}:${workingDir}`;
    }

    return `local:${workingDir}`;
}
