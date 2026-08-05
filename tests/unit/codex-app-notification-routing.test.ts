import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppClient } from '../../src/agent/codex-app-client.ts';

const laneOptions = { model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false };

const turnOwned = [
    'thread/tokenUsage/updated',
    'turn/diff/updated',
    'turn/plan/updated',
    'item/started',
    'item/autoApprovalReview/started',
    'item/autoApprovalReview/completed',
    'item/completed',
    'rawResponseItem/completed',
    'rawResponse/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/commandExecution/outputDelta',
    'item/commandExecution/terminalInteraction',
    'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated',
    'item/mcpToolCall/progress',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
    'thread/compacted',
    'model/rerouted',
    'model/verification',
    'turn/moderationMetadata',
    'model/safetyBuffering/updated',
];

const nullableTurn = ['thread/goal/updated', 'hook/started', 'hook/completed'];

const threadOwned = [
    'thread/status/changed',
    'thread/archived',
    'thread/deleted',
    'thread/unarchived',
    'thread/closed',
    'thread/name/updated',
    'thread/goal/cleared',
    'thread/environment/connected',
    'thread/environment/disconnected',
    'thread/settings/updated',
    'serverRequest/resolved',
    'guardianWarning',
];

const realtimeThread = [
    'thread/realtime/started',
    'thread/realtime/itemAdded',
    'thread/realtime/transcript/delta',
    'thread/realtime/transcript/done',
    'thread/realtime/outputAudio/delta',
    'thread/realtime/sdp',
    'thread/realtime/error',
    'thread/realtime/closed',
];

const nullableThread = [
    'mcpServer/oauthLogin/completed',
    'mcpServer/startupStatus/updated',
    'warning',
];

const requestHost = [
    'command/exec/outputDelta',
    'process/outputDelta',
    'process/exited',
    'externalAgentConfig/import/progress',
    'externalAgentConfig/import/completed',
    'fs/changed',
    'fuzzyFileSearch/sessionUpdated',
    'fuzzyFileSearch/sessionCompleted',
];

const processHost = [
    'skills/changed',
    'account/updated',
    'account/rateLimits/updated',
    'app/list/updated',
    'remoteControl/status/changed',
    'deprecationNotice',
    'configWarning',
    'windows/worldWritableWarning',
    'windowsSandbox/setupCompleted',
    'account/login/completed',
];

const allMethods = [
    'error',
    'turn/started',
    'turn/completed',
    ...turnOwned,
    ...nullableTurn,
    'thread/started',
    ...threadOwned,
    ...realtimeThread,
    ...nullableThread,
    ...requestHost,
    ...processHost,
];

function paramsFor(method: string): Record<string, unknown> {
    if (method === 'error') {
        return {
            threadId: 'thread-a', turnId: 'turn-a', willRetry: true,
            error: { message: 'retry' },
        };
    }
    if (method === 'turn/started' || method === 'turn/completed') {
        return { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } };
    }
    if (turnOwned.includes(method)) {
        return { threadId: 'thread-a', turnId: 'turn-a' };
    }
    if (nullableTurn.includes(method)) {
        return { threadId: 'thread-a', turnId: 'turn-a' };
    }
    if (method === 'thread/started') return { thread: { id: 'thread-a' } };
    if (threadOwned.includes(method) || realtimeThread.includes(method) || nullableThread.includes(method)) {
        return { threadId: 'thread-a' };
    }
    return {};
}

function expectedChannel(method: string): 'lane' | 'host' {
    return requestHost.includes(method) || processHost.includes(method) ? 'host' : 'lane';
}

async function readyClient(options: ConstructorParameters<typeof CodexAppClient>[0] = {}) {
    const client = new CodexAppClient(options);
    Object.defineProperty(client, 'request', {
        value: async (method: string) => {
            if (method === 'thread/start') return { thread: { id: 'thread-a' } };
            if (method === 'turn/start') return { turn: { id: 'turn-a' } };
            return {};
        },
    });
    await client.startThread('scope-a', laneOptions);
    await client.startTurn('scope-a', 'hello');
    return client;
}

test('generated notification contract contains 72 unique methods', () => {
    assert.equal(allMethods.length, 72);
    assert.equal(new Set(allMethods).size, 72);
});

test('all 72 generated notifications route to exactly one canonical channel', async () => {
    for (const method of allMethods) {
        const client = await readyClient();
        const seen = { lane: 0, host: 0, unknown: 0 };
        client.on('notification:scope-a', () => { seen.lane += 1; });
        client.on('host-notification', () => { seen.host += 1; });
        client.on('unrouted-notification', () => { seen.unknown += 1; });

        client['handleLine'](JSON.stringify({ method, params: paramsFor(method) }));

        const expected = expectedChannel(method);
        assert.equal(seen[expected], 1, `${method} did not reach ${expected}`);
        assert.equal(seen[expected === 'lane' ? 'host' : 'lane'], 0, `${method} crossed channels`);
        assert.equal(seen.unknown, 0, `${method} was treated as unknown`);
        client.cleanup();
    }
});

test('nullable thread and nullable turn methods use host and thread lanes respectively', async () => {
    for (const method of nullableThread) {
        const client = await readyClient();
        const seen: string[] = [];
        client.on('host-notification', (routed) => { seen.push(`host:${routed}`); });
        client.on('notification:scope-a', (routed) => { seen.push(`lane:${routed}`); });
        client['handleLine'](JSON.stringify({ method, params: { threadId: null } }));
        assert.deepEqual(seen, [`host:${method}`]);
        client.cleanup();
    }

    for (const method of nullableTurn) {
        const client = await readyClient();
        const owners: unknown[] = [];
        client.on('notification:scope-a', (_routed, _params, owner) => { owners.push(owner); });
        client['handleLine'](JSON.stringify({
            method,
            params: { threadId: 'thread-a', turnId: null },
        }));
        assert.deepEqual(owners, [{ threadId: 'thread-a', turnId: null }]);
        client.cleanup();
    }
});

test('legacy-raw unknown policy diagnoses and forwards future methods exactly once', async () => {
    const client = await readyClient({ unknownNotificationPolicy: 'legacy-raw' });
    const seen = { raw: 0, diagnostic: 0, lane: 0, host: 0 };
    client.on('notification', () => { seen.raw += 1; });
    client.on('unrouted-notification', () => { seen.diagnostic += 1; });
    client.on('notification:scope-a', () => { seen.lane += 1; });
    client.on('host-notification', () => { seen.host += 1; });

    client['handleLine'](JSON.stringify({ method: 'future/newNotification', params: { value: 1 } }));
    assert.deepEqual(seen, { raw: 1, diagnostic: 1, lane: 0, host: 0 });
});

test('diagnostic-only unknown policy blocks raw delivery without touching lane state', async () => {
    const client = await readyClient({ unknownNotificationPolicy: 'diagnostic-only' });
    const seen = { raw: 0, diagnostic: 0, lane: 0, host: 0 };
    client.on('notification', () => { seen.raw += 1; });
    client.on('unrouted-notification', () => { seen.diagnostic += 1; });
    client.on('notification:scope-a', () => { seen.lane += 1; });
    client.on('host-notification', () => { seen.host += 1; });

    client['handleLine'](JSON.stringify({ method: 'future/newNotification', params: { value: 1 } }));
    assert.deepEqual(seen, { raw: 0, diagnostic: 1, lane: 0, host: 0 });
    assert.equal(client.getThreadId('scope-a'), 'thread-a');
    assert.equal(client.getActiveTurnId('scope-a'), 'turn-a');
});

test('malformed known identity is diagnosed and never falls through unknown raw policy', async () => {
    const client = await readyClient({ unknownNotificationPolicy: 'legacy-raw' });
    const seen = { raw: 0, diagnostic: 0, lane: 0, host: 0 };
    client.on('notification', () => { seen.raw += 1; });
    client.on('unrouted-notification', () => { seen.diagnostic += 1; });
    client.on('notification:scope-a', () => { seen.lane += 1; });
    client.on('host-notification', () => { seen.host += 1; });

    client['handleLine'](JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', delta: 'missing turn' },
    }));
    assert.deepEqual(seen, { raw: 0, diagnostic: 1, lane: 0, host: 0 });
});

test('unscoped protocol error uses the host channel exactly once', async () => {
    const client = await readyClient();
    const seen = { host: 0, lane: 0 };
    client.on('host-notification', (method) => {
        if (method === 'error') seen.host += 1;
    });
    client.on('notification:scope-a', () => { seen.lane += 1; });

    client['handleLine'](JSON.stringify({
        method: 'error',
        params: { error: { message: 'legacy error' }, willRetry: false },
    }));
    assert.deepEqual(seen, { host: 1, lane: 0 });
});
