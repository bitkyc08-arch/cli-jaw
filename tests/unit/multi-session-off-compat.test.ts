import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { groupQueueKey } from '../../src/messaging/session-key.ts';
import { slackTargetFromId } from '../../src/messaging/slack-target.ts';
import { DEFAULT_SETTINGS, settings } from '../../src/core/config.ts';
import { addBroadcastListener, broadcast, removeBroadcastListener } from '../../src/core/bus.ts';
import { withSessionScope } from '../../src/core/session-context.ts';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

test('OFF is the default and captured context adds no event fields', () => {
    assert.deepEqual(DEFAULT_SETTINGS.multiSession, {
        enabled: false,
        maxConcurrent: 1,
        midRunPolicy: 'steer',
        channels: { telegram: false, discord: false, slack: true },
    });
    settings.multiSession = {
        enabled: false,
        maxConcurrent: 1,
        midRunPolicy: 'steer',
        channels: { telegram: false, discord: false, slack: true },
    };
    const received: Array<Record<string, unknown>> = [];
    const listener = (_type: string, data: Record<string, unknown>) => { received.push(data); };
    addBroadcastListener(listener);
    try {
        withSessionScope({ scope: 'scope-A', chatSessionId: 'session-A' }, () => {
            broadcast('system_notice', { marker: 'off-byte-contract' });
        });
    } finally {
        removeBroadcastListener(listener);
    }
    assert.deepEqual(received, [{ marker: 'off-byte-contract' }]);
});

test('OFF preserves legacy queue grouping bytes and does not rewrite persisted v1 rows', () => {
    const targetA = slackTargetFromId('C1', { threadTs: '171.2' });
    const targetB = slackTargetFromId('D1');
    assert.equal(groupQueueKey('slack', targetA), 'slack:slack:channel:channel:C1:thread:171.2');
    assert.equal(groupQueueKey('slack', targetB), 'slack:slack:direct:user:D1');

    const legacyPayload = JSON.stringify({
        id: 'legacy-v1', prompt: 'legacy prompt', source: 'slack', scope: 'default', target: targetA, ts: 1,
    });
    const persisted = new Map([['legacy-v1', legacyPayload]]);
    let migrationCalls = 0;
    let activeSessionReads = 0;
    const broadcasts: Array<{ type: string; data: Record<string, unknown> }> = [];
    const controller = createQueueController({
        migrateQueuedMessagesV1ToV2: () => { migrationCalls++; },
        isSpawnBusy: () => true,
        hasBlockingWorkers: () => false,
        hasPendingWorkerReplays: () => false,
        insertMessage: { run() { /* busy fixture never dequeues */ } },
        getActiveChatSession: () => { activeSessionReads++; return 'global-active'; },
        insertQueuedMessage: { run(id: string, payload: string) { persisted.set(id, payload); } },
        deleteQueuedMessage: { run(id: string) { persisted.delete(id); } },
        listQueuedMessages: { all: () => [{ id: 'legacy-v1', payload: persisted.get('legacy-v1')! }] },
        broadcast(type: string, data: Record<string, unknown>) { broadcasts.push({ type, data }); },
        importPipeline: async () => ({
            orchestrate: async () => {}, orchestrateContinue: async () => {}, orchestrateReset: async () => {},
            isContinueIntent: () => false, isResetIntent: () => false, drainPendingReplays: async () => {},
        }),
        getWorkingDir: () => null,
        isMultiSessionEnabled: () => false,
    }, new SessionLanes(() => 1));

    assert.equal(migrationCalls, 0);
    assert.equal(persisted.get('legacy-v1'), legacyPayload);
    assert.equal(activeSessionReads, 0);

    const newId = controller.enqueueMessage('new OFF prompt', 'slack', {
        target: targetB,
        scope: 'jaw:slack:direct:D1',
        chatSessionId: 'remote-session',
        remoteKey: 'jaw:slack:direct:D1',
        collect: true,
        front: true,
    });
    const newPayload = JSON.parse(persisted.get(newId)!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(newPayload), ['id', 'prompt', 'source', 'scope', 'target', 'ts']);
    assert.equal(newPayload.scope, 'default');
    assert.equal(newPayload.schemaVersion, undefined);
    assert.equal(newPayload.chatSessionId, undefined);
    assert.equal(newPayload.remoteKey, undefined);
    assert.equal(newPayload.collect, undefined);
    assert.equal(newPayload.priority, undefined);
    assert.equal(activeSessionReads, 0);
    assert.equal(broadcasts.at(-1)?.data.scope, undefined, 'OFF queue_update must not add scope');
});
