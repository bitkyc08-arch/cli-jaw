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

export type RequestSessionResolution =
    | ({ ok: true } & RequestSessionContext)
    | { ok: false; reason: 'unknown_session'; requested: string };

// A request that NAMES a session it cannot find fails closed. Falling back to the active
// session looks forgiving but writes one tab's message into a different session: tab A
// views X, X gets deleted, another tab makes Y active, and A's next send lands in Y.
// Sending no id at all is a different thing — it means "the active session", which is
// what every client did before per-tab routing and what the hub still does.
export function resolveRequestSessionStrict(rawSessionId: unknown): RequestSessionResolution {
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const requested = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    if (multiSessionEnabled && requested && getChatSessionById(requested) === null) {
        return { ok: false, reason: 'unknown_session', requested };
    }
    const chatSessionId = multiSessionEnabled && requested ? requested : getActiveChatSession();
    const remoteKey = getChatSessionRemoteKey(chatSessionId) ?? undefined;
    return {
        ok: true,
        chatSessionId,
        scope: scopeForChatSession(chatSessionId, remoteKey, multiSessionEnabled),
        ...(remoteKey ? { remoteKey } : {}),
    };
}
