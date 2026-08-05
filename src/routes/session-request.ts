// ─── Session context of a write request (072 §1.2a) ──
// A tab on /:seq sends the session it is viewing so the write lands there instead of
// on whatever session happens to be globally active. The client sends an id, never a
// scope string: the scope rule lives on the server (orchestrator/scope.ts) and a
// client that computed it would become a second place the rule can drift.

import { getActiveChatSession, getChatSessionById, getChatSessionRemoteKey } from '../core/chat-sessions.js';
import { scopeForChatSession } from '../orchestrator/scope.js';
import { settings } from '../core/config.js';

export type RequestSessionContext = {
    chatSessionId: string;
    scope: string;
    remoteKey?: string;
};

// An id that names no session falls back to the active one rather than failing the
// request: a tab racing a deletion should not lose the message it just typed.
export function resolveRequestSession(rawSessionId: unknown): RequestSessionContext {
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const requested = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    const chatSessionId = multiSessionEnabled && requested && getChatSessionById(requested) !== null
        ? requested
        : getActiveChatSession();
    const remoteKey = getChatSessionRemoteKey(chatSessionId) ?? undefined;
    return {
        chatSessionId,
        scope: scopeForChatSession(chatSessionId, remoteKey, multiSessionEnabled),
        ...(remoteKey ? { remoteKey } : {}),
    };
}
