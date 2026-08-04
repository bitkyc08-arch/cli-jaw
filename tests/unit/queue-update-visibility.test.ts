import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeController() {
    const broadcasts: Array<{ type: string; data: Record<string, unknown> }> = [];
    const persisted = new Map<string, string>();

    const controller = createQueueController({
        migrateQueuedMessagesV1ToV2() { /* no persisted rows in this fixture */ },
        isSpawnBusy: () => true,
        hasBlockingWorkers: () => false,
        hasPendingWorkerReplays: () => false,
        insertMessage: { run() { /* not used while busy */ } },
        insertQueuedMessage: {
            run(id: string, payload: string) {
                persisted.set(id, payload);
            },
        },
        deleteQueuedMessage: {
            run(id: string) {
                persisted.delete(id);
            },
        },
        listQueuedMessages: { all: () => [] },
        getActiveChatSession: () => 'default',
        broadcast(type: string, data: Record<string, unknown>) {
            broadcasts.push({ type, data });
        },
        importPipeline: async () => ({
            orchestrate: async () => {},
            orchestrateContinue: async () => {},
            orchestrateReset: async () => {},
            isContinueIntent: () => false,
            isResetIntent: () => false,
            drainPendingReplays: async () => {},
        }),
        getWorkingDir: () => '/tmp',
        isMultiSessionEnabled: () => false,
    }, new SessionLanes(() => 1));

    return { controller, broadcasts, persisted };
}

test('queue_update broadcasts queued details needed to render steer controls without a snapshot fetch', () => {
    const { controller, broadcasts } = makeController();

    const id = controller.enqueueMessage('steer this next', 'web', { scope: 'default' });
    const update = broadcasts.findLast(item => item.type === 'queue_update');

    assert.ok(update, 'enqueue should broadcast queue_update');
    assert.equal(update.data.pending, 1);
    const queued = update.data.queued as Array<{ id: string; prompt: string; source: string; ts: number }>;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, id);
    assert.equal(queued[0].prompt, 'steer this next');
    assert.equal(queued[0].source, 'web');
    assert.equal(typeof queued[0].ts, 'number');
    assert.ok(queued[0].ts > 0);
});

test('queue_update clears queued details when the pending row is removed', () => {
    const { controller, broadcasts } = makeController();

    const id = controller.enqueueMessage('remove this row', 'web', { scope: 'default' });
    broadcasts.length = 0;

    controller.removeQueuedMessage(id);
    const update = broadcasts.findLast(item => item.type === 'queue_update');

    assert.ok(update, 'remove should broadcast queue_update');
    assert.equal(update.data.pending, 0);
    assert.deepEqual(update.data.queued, []);
});

test('snapshot endpoint includes queued details for reload recovery (X-01)', () => {
    // devlog 260609, 50: the WS connect-time queue_update push was removed —
    // reload recovery flows through /api/orchestrate/snapshot, which the
    // frontend fetches in handleChannelUp on every (re)connect.
    const orcSrc = readFileSync(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');
    const snapStart = orcSrc.indexOf("app.get('/api/orchestrate/snapshot'");
    assert.ok(snapStart >= 0, 'snapshot route should exist');
    const snapBlock = orcSrc.slice(snapStart, snapStart + 3000);
    assert.ok(snapBlock.includes('getRuntimeSnapshot()'),
        'snapshot route must serve the runtime block (queuePending source)');
    assert.ok(orcSrc.includes('queuePending: messageQueue.length'),
        'runtime snapshot must include the pending count');
    assert.ok(snapBlock.includes('queued: getQueuedMessageSnapshotForScope(scope)'),
        'snapshot must include queued rows for reload recovery');
});

test('frontend queue_update renders pending queue rows from websocket payload before snapshot fallback', () => {
    const wsSrc = readFileSync(join(__dirname, '../../public/js/ws.ts'), 'utf8');
    const queueIdx = wsSrc.indexOf("msg.type === 'queue_update'");
    const worklogIdx = wsSrc.indexOf("msg.type === 'worklog_created'", queueIdx);
    const block = wsSrc.slice(queueIdx, worklogIdx);

    assert.ok(block.includes('Array.isArray(msg.queued)'), 'queue_update should accept queued rows from websocket payload');
    assert.ok(block.includes('renderPendingQueue(msg.queued)'), 'queue_update should render steer controls immediately');
    assert.ok(block.indexOf('renderPendingQueue(msg.queued)') < block.indexOf("syncOrchestrateSnapshot('queue_update')"), 'websocket rows should render before async snapshot fallback');
});

test('queue badge stays inside the send button so iframe clipping cannot hide it', () => {
    const cssSrc = readFileSync(join(__dirname, '../../public/css/variables.css'), 'utf8');
    const start = cssSrc.indexOf('.queue-badge');
    const block = cssSrc.slice(start, start + 220);

    assert.ok(block.includes('top: 6px;'), 'queue badge should sit inside the button vertically');
    assert.ok(block.includes('right: 6px;'), 'queue badge should sit inside the button horizontally');
    assert.ok(!block.includes('top: -6px;'), 'queue badge should not be positioned outside the iframe viewport');
    assert.ok(!block.includes('right: -6px;'), 'queue badge should not be positioned outside the iframe viewport');
});
