import { getChatSessionRemoteKey } from '../core/chat-sessions.js';
import {
    activeMainProcesses,
    getQueueHoldId,
    isQueueBusy,
    isScopedQueue,
    isRetryPending,
    messageQueue,
} from '../agent/spawn.js';
import {
    hasBlockingWorkers,
    hasPendingWorkerReplays,
    listPendingWorkerResults,
} from './worker-registry.js';
import { sessionLanes } from './session-lanes.js';
import { LOCAL_SESSION_SCOPE_ACTIVATION, scopeForChatSession } from './scope.js';

export function hasChatSessionWork(
    sessionId: string,
    localSessionScopesEnabled = LOCAL_SESSION_SCOPE_ACTIVATION,
): boolean {
    if ([...activeMainProcesses.values()].some(run => run.meta.chatSessionId === sessionId)) return true;
    if (messageQueue.some(item => item.chatSessionId === sessionId)) return true;

    const remoteKey = getChatSessionRemoteKey(sessionId) ?? undefined;
    // The queue reads the multi-session gate once at construction and collapses every scope
    // onto 'default' when it is off. Asking the queue itself keeps this key on the same lane
    // the queue actually uses; re-reading settings here would drift after a settings change.
    const scopeKey = scopeForChatSession(
        sessionId,
        remoteKey,
        isScopedQueue() && (remoteKey !== undefined || localSessionScopesEnabled),
    );
    if (listPendingWorkerResults(scopeKey).some(result => result.meta?.chatSessionId === sessionId)) return true;

    return isQueueBusy(scopeKey)
        || isRetryPending(scopeKey)
        || getQueueHoldId(scopeKey) !== null
        || hasBlockingWorkers(scopeKey)
        || hasPendingWorkerReplays(scopeKey)
        || sessionLanes.hasPending(scopeKey);
}
