import { getChatSessionRemoteKey } from '../core/chat-sessions.js';
import {
    activeMainProcesses,
    getQueueHoldId,
    isQueueBusy,
    isRetryPending,
    messageQueue,
} from '../agent/spawn.js';
import {
    hasBlockingWorkers,
    hasPendingWorkerReplays,
    listPendingWorkerResults,
} from './worker-registry.js';
import { sessionLanes } from './session-lanes.js';

export function hasChatSessionWork(sessionId: string): boolean {
    if ([...activeMainProcesses.values()].some(run => run.meta.chatSessionId === sessionId)) return true;
    if (messageQueue.some(item => item.chatSessionId === sessionId)) return true;

    const scopeKey = getChatSessionRemoteKey(sessionId) ?? 'default';
    if (listPendingWorkerResults(scopeKey).some(result => result.meta?.chatSessionId === sessionId)) return true;

    return isQueueBusy(scopeKey)
        || isRetryPending(scopeKey)
        || getQueueHoldId(scopeKey) !== null
        || hasBlockingWorkers(scopeKey)
        || hasPendingWorkerReplays(scopeKey)
        || sessionLanes.hasPending(scopeKey);
}
