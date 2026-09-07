import { getActiveChatSession, getChatSessionById, getChatSessionRemoteKey } from '../core/chat-sessions.js';
import { settings } from '../core/config.js';
import { publish } from '../core/event-bus.js';
import { scopeForChatSession } from '../orchestrator/scope.js';
import { parseRuntimeRequestNotice, RUNTIME_REQUEST_NOTICE_EVENT,
    type RuntimeRequestNotice } from '../shared/runtime-request-notice.js';

/** Resolve presentation placement without rewriting the captured execution identity. */
export function resolveRuntimeRequestNotice(sessionId: string): RuntimeRequestNotice | null {
    if (!getChatSessionById(sessionId)) return null;
    const multiSessionEnabled = settings['multiSession']?.enabled === true;
    // Disabled multi-session UI cannot present a different captured chat. Never alias it.
    if (!multiSessionEnabled && getActiveChatSession() !== sessionId) return null;
    const remoteKey = getChatSessionRemoteKey(sessionId) ?? undefined;
    return parseRuntimeRequestNotice({ version: 1, sessionId,
        scope: scopeForChatSession(sessionId, remoteKey, multiSessionEnabled) });
}

export function publishRuntimeRequestNotice(sessionId: string): void {
    const notice = resolveRuntimeRequestNotice(sessionId);
    if (notice) publish('agent', RUNTIME_REQUEST_NOTICE_EVENT, { ...notice });
}
