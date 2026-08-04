import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    db,
    deleteQueuedMessage,
    insertMessage,
    insertQueuedMessage,
    listQueuedMessages,
    migrateQueuedMessagesV1ToV2,
} from '../../src/core/db.ts';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { createChatSession, getSessionRunPolicy, setSessionRunPolicy } from '../../src/core/chat-sessions.ts';
import { settings } from '../../src/core/config.ts';
import { slackTargetFromId } from '../../src/messaging/slack-target.ts';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

afterEach(() => {
    db.prepare("DELETE FROM queued_messages WHERE id LIKE 'queue-v2-%'").run();
    db.prepare("DELETE FROM messages WHERE content LIKE 'queue-v2-%'").run();
    db.prepare("DELETE FROM chat_sessions WHERE id LIKE 'queue-v2-%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
});

function makeController(options: {
    busy: (scopeKey: string) => boolean;
    metas?: Array<Record<string, unknown>>;
    runs?: Array<{ prompt: string; meta: Record<string, unknown> }>;
    maxConcurrent?: number;
}) {
    return createQueueController({
        migrateQueuedMessagesV1ToV2,
        isSpawnBusy: options.busy,
        hasBlockingWorkers: () => false,
        hasPendingWorkerReplays: () => false,
        insertMessage,
        getActiveChatSession: () => (
            db.prepare("SELECT active_chat_session FROM session WHERE id = 'default'").pluck().get() as string || 'default'
        ),
        insertQueuedMessage,
        deleteQueuedMessage,
        listQueuedMessages: listQueuedMessages as unknown as { all(): Array<{ id: string; payload: string }> },
        broadcast() { /* assertions use durable rows */ },
        importPipeline: async () => ({
            orchestrate: async (prompt: string, meta: Record<string, unknown>) => {
                options.metas?.push(meta);
                options.runs?.push({ prompt, meta });
            },
            orchestrateContinue: async (meta: Record<string, unknown>) => { options.metas?.push(meta); },
            orchestrateReset: async (meta: Record<string, unknown>) => { options.metas?.push(meta); },
            isContinueIntent: () => false,
            isResetIntent: () => false,
            drainPendingReplays: async () => {},
        }),
        getWorkingDir: () => null,
        isMultiSessionEnabled: () => true,
    }, new SessionLanes(() => options.maxConcurrent ?? 2));
}

test('ON migration rewrites v1 once and drops a deleted-session v2 row once', () => {
    const v1 = { id: 'queue-v2-v1', prompt: 'queue-v2-v1', source: 'slack', scope: 'legacy-scope', ts: 1 };
    const deletedV2 = {
        schemaVersion: 2,
        id: 'queue-v2-deleted',
        prompt: 'queue-v2-deleted',
        source: 'slack',
        scope: 'jaw:slack:channel:missing',
        chatSessionId: 'queue-v2-missing-session',
        remoteKey: 'jaw:slack:channel:missing',
        ts: 2,
    };
    insertQueuedMessage.run(v1.id, JSON.stringify(v1));
    insertQueuedMessage.run(deletedV2.id, JSON.stringify(deletedV2));

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
        const first = makeController({ busy: () => true });
        assert.equal(first.messageQueue.length, 1);
        const rewrittenRaw = db.prepare('SELECT payload FROM queued_messages WHERE id = ?').pluck().get(v1.id) as string;
        const rewritten = JSON.parse(rewrittenRaw) as Record<string, unknown>;
        assert.equal(rewritten.schemaVersion, 2);
        assert.equal(rewritten.scope, 'default');
        assert.equal(rewritten.chatSessionId, 'default');
        assert.equal(db.prepare('SELECT 1 FROM queued_messages WHERE id = ?').get(deletedV2.id), undefined);
        assert.deepEqual(warnings, ['[queue:migrate:v2] dropped deleted-session rows: queue-v2-deleted']);

        const beforeSecond = db.prepare('SELECT total_changes()').pluck().get() as number;
        const second = makeController({ busy: () => true });
        const afterSecond = db.prepare('SELECT total_changes()').pluck().get() as number;
        assert.equal(second.messageQueue.length, 1);
        assert.equal(afterSecond - beforeSecond, 0, 'second migration must not rewrite or drop rows');
        assert.equal(warnings.length, 1, 'deleted-session warning must be emitted only by the dropping pass');
    } finally {
        console.warn = originalWarn;
    }
});

test('v2 restart preserves A/B capture and ignores a later global session switch', async () => {
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-a', 801, 'A')").run();
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-b', 802, 'B')").run();
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-global', 803, 'global')").run();
    const payloads = [
        {
            schemaVersion: 2, id: 'queue-v2-row-a', prompt: 'queue-v2-message-a', source: 'slack',
            scope: 'jaw:slack:channel:C1', chatSessionId: 'queue-v2-a', remoteKey: 'jaw:slack:channel:C1',
            target: slackTargetFromId('C1'), ts: 10,
        },
        {
            schemaVersion: 2, id: 'queue-v2-row-b', prompt: 'queue-v2-message-b', source: 'slack',
            scope: 'jaw:slack:channel:C2', chatSessionId: 'queue-v2-b', remoteKey: 'jaw:slack:channel:C2',
            target: slackTargetFromId('C2'), ts: 11,
        },
    ];
    for (const payload of payloads) insertQueuedMessage.run(payload.id, JSON.stringify(payload));

    let busy = true;
    const metas: Array<Record<string, unknown>> = [];
    const controller = makeController({ busy: () => busy, metas });
    assert.deepEqual(
        controller.messageQueue.map(item => ({ scope: item.scope, chatSessionId: item.chatSessionId, remoteKey: item.remoteKey })),
        payloads.map(item => ({ scope: item.scope, chatSessionId: item.chatSessionId, remoteKey: item.remoteKey })),
    );

    db.prepare("UPDATE session SET active_chat_session = 'queue-v2-global' WHERE id = 'default'").run();
    busy = false;
    await controller.processQueue('default');
    for (let i = 0; i < 10 && (controller.messageQueue.length > 0 || controller.isQueueBusy(null) || metas.length < 2); i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(controller.messageQueue.length, 0);
    assert.equal(controller.isQueueBusy(null), false);

    const rows = db.prepare("SELECT content, session_id FROM messages WHERE content LIKE 'queue-v2-message-%' ORDER BY content").all() as Array<{ content: string; session_id: string }>;
    assert.deepEqual(rows, [
        { content: 'queue-v2-message-a', session_id: 'queue-v2-a' },
        { content: 'queue-v2-message-b', session_id: 'queue-v2-b' },
    ]);
    assert.deepEqual(
        metas.map(meta => ({ scope: meta.scope, chatSessionId: meta.chatSessionId, remoteKey: meta.remoteKey })),
        payloads.map(item => ({ scope: item.scope, chatSessionId: item.chatSessionId, remoteKey: item.remoteKey })),
    );
});

test('collect merges only not-yet-started items from the same scope', async () => {
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-collect-a', 811, 'A')").run();
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-collect-b', 812, 'B')").run();
    const blocked = new Set(['A', 'B']);
    const runs: Array<{ prompt: string; meta: Record<string, unknown> }> = [];
    const controller = makeController({ busy: scope => blocked.has(scope), runs });

    controller.enqueueMessage('queue-v2-collect-a2', 'web', { scope: 'A', chatSessionId: 'queue-v2-collect-a', collect: true });
    controller.enqueueMessage('queue-v2-collect-a3', 'web', { scope: 'A', chatSessionId: 'queue-v2-collect-a', collect: true });
    controller.enqueueMessage('queue-v2-collect-b1', 'web', { scope: 'B', chatSessionId: 'queue-v2-collect-b', collect: true });
    blocked.clear();

    await Promise.all([controller.processQueue('A'), controller.processQueue('B')]);
    for (let i = 0; i < 10 && (controller.messageQueue.length > 0 || controller.isQueueBusy(null)); i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }

    assert.deepEqual(runs.map(run => ({ prompt: run.prompt, scope: run.meta.scope })), [
        { prompt: 'queue-v2-collect-a2\n\nqueue-v2-collect-a3', scope: 'A' },
        { prompt: 'queue-v2-collect-b1', scope: 'B' },
    ]);
    const rows = db.prepare("SELECT content, session_id FROM messages WHERE content LIKE 'queue-v2-collect-%' ORDER BY session_id").all();
    assert.deepEqual(rows, [
        { content: 'queue-v2-collect-a2\n\nqueue-v2-collect-a3', session_id: 'queue-v2-collect-a' },
        { content: 'queue-v2-collect-b1', session_id: 'queue-v2-collect-b' },
    ]);
});

test('interrupt purge preserves B and restarts with the latest A item at queue head', () => {
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-interrupt-a', 821, 'A')").run();
    db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-interrupt-b', 822, 'B')").run();
    const controller = makeController({ busy: () => true, maxConcurrent: 1 });
    const oldA = controller.enqueueMessage('queue-v2-interrupt-a-old', 'web', { scope: 'A', chatSessionId: 'queue-v2-interrupt-a' });
    const b = controller.enqueueMessage('queue-v2-interrupt-b', 'web', { scope: 'B', chatSessionId: 'queue-v2-interrupt-b' });

    controller.purgeQueueOnStop('A', 'interrupt');
    const latestA = controller.enqueueMessage('queue-v2-interrupt-a-latest', 'web', {
        scope: 'A', chatSessionId: 'queue-v2-interrupt-a', front: true,
    });
    assert.deepEqual(controller.messageQueue.map(item => item.id), [latestA, b]);
    assert.equal(db.prepare('SELECT 1 FROM queued_messages WHERE id = ?').get(oldA), undefined);

    const recovered = makeController({ busy: () => true, maxConcurrent: 1 });
    assert.deepEqual(recovered.messageQueue.map(item => item.id), [latestA, b]);
});

test('session run policies survive reads and new sessions capture the current global default', () => {
    const previous = { ...settings.multiSession };
    let createdId = '';
    try {
        settings.multiSession = { enabled: true, maxConcurrent: 2, midRunPolicy: 'collect' };
        db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-policy-a', 831, 'A')").run();
        db.prepare("INSERT INTO chat_sessions (id, seq, label) VALUES ('queue-v2-policy-b', 832, 'B')").run();
        setSessionRunPolicy('queue-v2-policy-a', 'collect');
        setSessionRunPolicy('queue-v2-policy-b', 'interrupt');

        settings.multiSession.midRunPolicy = 'followup';
        assert.equal(getSessionRunPolicy('queue-v2-policy-a'), 'collect');
        assert.equal(getSessionRunPolicy('queue-v2-policy-b'), 'interrupt');

        const created = createChatSession('queue-v2-policy-new');
        createdId = created.id;
        assert.equal(getSessionRunPolicy(created.id), 'followup');
    } finally {
        if (createdId) db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(createdId);
        settings.multiSession = previous;
    }
});
