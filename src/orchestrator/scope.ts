import { settings } from '../core/config.js';
import { listActiveOrcStates } from '../core/db.js';
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

/**
 * Find an existing active (non-IDLE) scope row matching the given origin/chatId.
 * Used when workingDir may have changed mid-phase — the old scope row has the
 * persisted scopeId that should be reused.
 *
 * When multiple active rows match, returns the most recently updated one.
 * This is a best-effort heuristic: if a user runs concurrent PABCD flows
 * from different directories, the most-recently-active flow wins.
 */
export function findActiveScope(origin: string, chatId?: string | number): string | null {
    const activeRows = listActiveOrcStates.all() as Array<{ id: string; updated_at: string }>;
    if (!activeRows.length) return null;

    let matches: Array<{ id: string; updated_at: string }>;

    if (origin === 'telegram' || origin === 'discord') {
        const chatKey = normalizeRemoteKey(undefined, chatId);
        const prefix = `${origin}:${chatKey}:`;
        matches = activeRows.filter(r => r.id.startsWith(prefix));
    } else {
        matches = activeRows.filter(r => r.id.startsWith('local:'));
    }

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0]!.id;

    // Multiple active scopes for this origin — pick most recently updated
    matches.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
    return matches[0]!.id;
}
