import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';

const scopeCalls: Array<{ sessionId: string; remoteKey?: string; gateEnabled?: boolean }> = [];
let submittedScope: string | undefined;

mock.module('../../src/core/chat-sessions.ts', {
    namedExports: {
        getActiveChatSession: () => 'active-session',
        resolveOrCreateRemoteSession: () => 'remote-session',
    },
});

mock.module('../../src/orchestrator/scope.ts', {
    namedExports: {
        channelGateOn: () => true,
        scopeForChatSession: (sessionId: string, remoteKey?: string, gateEnabled?: boolean) => {
            scopeCalls.push({ sessionId, ...(remoteKey ? { remoteKey } : {}), ...(gateEnabled === undefined ? {} : { gateEnabled }) });
            return 'canonical:sentinel';
        },
    },
});

mock.module('../../src/orchestrator/gateway.ts', {
    namedExports: {
        submitMessage: (_prompt: string, meta: { scope?: string }) => {
            submittedScope = meta.scope;
            return { action: 'rejected', reason: 'test-stop' };
        },
    },
});

const { admitSlackRun } = await import('../../src/slack/ingress.ts');

test('Slack ingress delegates its resolved chat identity to the canonical scope helper', () => {
    settings.multiSession = { enabled: true, channels: { slack: true } };
    scopeCalls.length = 0;
    submittedScope = undefined;

    admitSlackRun({
        target: {
            channel: 'slack',
            targetKind: 'channel',
            peerKind: 'channel',
            targetId: 'C1',
        },
        prompt: 'hello',
        displayText: 'hello',
        chatId: 'C1',
        runReply: async () => {},
    });

    assert.deepEqual(scopeCalls, [{
        sessionId: 'remote-session',
        remoteKey: 'jaw:slack:channel:C1',
        gateEnabled: true,
    }]);
    assert.equal(submittedScope, 'canonical:sentinel');
});
