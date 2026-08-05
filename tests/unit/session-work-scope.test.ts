import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const scopeCalls: Array<{ sessionId: string; remoteKey?: string; gateEnabled?: boolean }> = [];
const queueBusyScopes: string[] = [];

mock.module('../../src/core/chat-sessions.ts', {
    namedExports: { getChatSessionRemoteKey: () => null },
});

mock.module('../../src/orchestrator/scope.ts', {
    namedExports: {
        LOCAL_SESSION_SCOPE_ACTIVATION: false,
        scopeForChatSession: (sessionId: string, remoteKey?: string, gateEnabled?: boolean) => {
            scopeCalls.push({ sessionId, ...(remoteKey ? { remoteKey } : {}), ...(gateEnabled === undefined ? {} : { gateEnabled }) });
            return gateEnabled ? 'canonical:sentinel' : 'default';
        },
    },
});

mock.module('../../src/agent/spawn.ts', {
    namedExports: {
        activeMainProcesses: new Map(),
        getQueueHoldId: () => null,
        isQueueBusy: (scope: string) => {
            queueBusyScopes.push(scope);
            return scope === 'canonical:sentinel';
        },
        isRetryPending: () => false,
        messageQueue: [],
    },
});

mock.module('../../src/orchestrator/worker-registry.ts', {
    namedExports: {
        hasBlockingWorkers: () => false,
        hasPendingWorkerReplays: () => false,
        listPendingWorkerResults: () => [],
    },
});

mock.module('../../src/orchestrator/session-lanes.ts', {
    namedExports: { sessionLanes: { hasPending: () => false } },
});

const { hasChatSessionWork } = await import('../../src/orchestrator/session-work.ts');

test('session-work delegates session identity to the canonical helper before probing scope state', () => {
    scopeCalls.length = 0;
    queueBusyScopes.length = 0;

    assert.equal(hasChatSessionWork('local-session', true), true);
    assert.deepEqual(scopeCalls, [{ sessionId: 'local-session', gateEnabled: true }]);
    assert.deepEqual(queueBusyScopes, ['canonical:sentinel']);
});

test('session-work keeps local scope activation off by default', () => {
    scopeCalls.length = 0;
    queueBusyScopes.length = 0;

    assert.equal(hasChatSessionWork('local-session'), false);
    assert.deepEqual(scopeCalls, [{ sessionId: 'local-session', gateEnabled: false }]);
    assert.deepEqual(queueBusyScopes, ['default']);
});
