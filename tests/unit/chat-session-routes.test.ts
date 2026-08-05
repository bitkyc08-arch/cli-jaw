import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerChatSessionRoutes } from '../../src/routes/chat-sessions.ts';
import { db } from '../../src/core/db.ts';
import { addBroadcastListener, clearAllBroadcastListeners } from '../../src/core/bus.ts';
import { settings } from '../../src/core/config.ts';
import {
    activeMainProcesses,
    clearQueueHold,
    isScopedQueue,
    isRetryPending,
    messageQueue,
    retryStateForScope,
    setQueueHold,
} from '../../src/agent/spawn.ts';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { SessionLanes, sessionLanes } from '../../src/orchestrator/session-lanes.ts';
import { scopeForChatSession } from '../../src/orchestrator/scope.ts';
import { claimWorker, clearAllWorkers } from '../../src/orchestrator/worker-registry.ts';

const IDS = ['route-delete', 'route-active', 'route-queued', 'route-hold', 'route-worker', 'route-lane', 'route-remote'];

function testAuth(req: Request, res: Response, next: NextFunction): void {
    if (req.header('x-test-network') !== 'remote' || req.header('authorization') === 'Bearer valid') next();
    else res.status(401).json({ error: 'Unauthorized' });
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    registerChatSessionRoutes(app, testAuth);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

function insertSession(id: string, seq: number): void {
    db.prepare('INSERT INTO chat_sessions (id, seq, label) VALUES (?, ?, ?)').run(id, seq, id);
}

afterEach(() => {
    activeMainProcesses.clear();
    messageQueue.splice(0);
    clearQueueHold(null, 'route-hold-id', { resume: false });
    clearAllWorkers();
    clearAllBroadcastListeners();
    db.prepare(`DELETE FROM messages WHERE session_id IN (${IDS.map(() => '?').join(',')})`).run(...IDS);
    db.prepare(`DELETE FROM remote_session_bindings WHERE chat_session_id IN (${IDS.map(() => '?').join(',')})`).run(...IDS);
    db.prepare(`DELETE FROM chat_sessions WHERE id IN (${IDS.map(() => '?').join(',')})`).run(...IDS);
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    settings.multiSession.enabled = false;
});

test('every chat-session route applies auth while loopback/LAN bypass semantics remain in server requireAuth', async () => {
    await withServer(async baseUrl => {
        const cases: Array<[string, RequestInit]> = [
            ['/api/chat-sessions', {}],
            ['/api/chat-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
            ['/api/chat-sessions/0/switch', { method: 'POST' }],
            ['/api/chat-sessions/default', { method: 'DELETE' }],
        ];
        for (const [path, init] of cases) {
            const response = await fetch(baseUrl + path, {
                ...init,
                headers: { ...(init.headers || {}), 'x-test-network': 'remote' },
            });
            assert.equal(response.status, 401, `${init.method || 'GET'} ${path}`);
        }
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions`)).status, 200, 'loopback bypass');
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions`, { headers: { 'x-test-network': 'lan' } })).status, 200, 'LAN bypass');
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions`, {
            headers: { 'x-test-network': 'remote', authorization: 'Bearer valid' },
        })).status, 200, 'remote bearer');
    });

    const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
    assert.match(serverSource, /isLoopback \|\| isLanBypass/);
    assert.match(serverSource, /token !== JAW_AUTH_TOKEN/);
    assert.match(serverSource, /registerChatSessionRoutes\(app, requireAuth\)/);
});

test('DELETE removes a local session and its messages atomically and broadcasts deleted id plus seq', async () => {
    settings.multiSession.enabled = true;
    insertSession('route-delete', 930);
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'route-delete-message', 'route-delete')").run();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    addBroadcastListener((type, data) => events.push({ type, data }));

    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/api/chat-sessions/route-delete`, { method: 'DELETE' });
        assert.equal(response.status, 200);
    });
    assert.equal(db.prepare("SELECT 1 FROM chat_sessions WHERE id = 'route-delete'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM messages WHERE session_id = 'route-delete'").get(), undefined);
    const event = events.find(item => item.type === 'session_list');
    assert.deepEqual(event?.data.deleted, { id: 'route-delete', seq: 930 });
});

test("DELETE rejects 'default' with 400", async () => {
    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/api/chat-sessions/default`, { method: 'DELETE' });
        assert.equal(response.status, 400);
    });
});

test('DELETE returns 409 for exact active-run and queued-item matches', async () => {
    settings.multiSession.enabled = true;
    insertSession('route-active', 931);
    insertSession('route-queued', 932);
    activeMainProcesses.set('other-scope', {
        process: null, starting: true, steering: false, ownerGeneration: 1,
        meta: { origin: 'web', chatSessionId: 'route-active' },
    });
    messageQueue.push({ id: 'route-queued-item', prompt: 'queued', source: 'web', scope: 'default', chatSessionId: 'route-queued', ts: 1 });
    await withServer(async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions/route-active`, { method: 'DELETE' })).status, 409);
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions/route-queued`, { method: 'DELETE' })).status, 409);
    });
});

// The production queue captures the multi-session gate at construction, and session-work
// follows that same captured value (isScopedQueue) rather than re-reading settings — which
// is what keeps these 409s real: a scope key the queue never fills would report "no work"
// for a session that has some. So the work here has to be seeded on the lane the queue
// actually uses, which is what scopeForChatSession resolves it to.
test('DELETE returns 409 for hold, worker, and session-lane work on the queue own lane', async () => {
    settings.multiSession.enabled = true;
    insertSession('route-hold', 933);
    insertSession('route-worker', 934);
    insertSession('route-lane', 935);

    const queueLane = (sessionId: string) => scopeForChatSession(sessionId, undefined, isScopedQueue());

    setQueueHold(queueLane('route-hold'), 'route-hold-id', 60_000);
    await withServer(async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions/route-hold`, { method: 'DELETE' })).status, 409);
    });
    clearQueueHold(queueLane('route-hold'), 'route-hold-id', { resume: false });

    claimWorker({ id: 'route-worker-agent', name: 'Route Worker' }, 'pending', { scopeId: queueLane('route-worker'), chatSessionId: 'route-worker' });
    await withServer(async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions/route-worker`, { method: 'DELETE' })).status, 409);
    });
    clearAllWorkers();

    let release!: () => void;
    const pending = sessionLanes.run(queueLane('route-lane'), () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    await withServer(async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/chat-sessions/route-lane`, { method: 'DELETE' })).status, 409);
    });
    release();
    await pending;
});

test('retry and queue-drain windows are observable and wired to conservative 409 work detection', async () => {
    type FakePipeline = {
        orchestrate: (...args: unknown[]) => Promise<void>;
        orchestrateContinue: (...args: unknown[]) => Promise<void>;
        orchestrateReset: (...args: unknown[]) => Promise<void>;
        isContinueIntent: (text: string) => boolean;
        isResetIntent: (text: string) => boolean;
        drainPendingReplays: (...args: unknown[]) => Promise<void>;
    };
    let releasePipeline!: (pipeline: FakePipeline) => void;
    const pipelineGate = new Promise<FakePipeline>(resolve => { releasePipeline = resolve; });
    const controller = createQueueController({
        migrateQueuedMessagesV1ToV2() {},
        isSpawnBusy: () => false,
        hasBlockingWorkers: () => false,
        hasPendingWorkerReplays: () => false,
        insertMessage: { run() {} },
        getActiveChatSession: () => 'route-delete',
        insertQueuedMessage: { run() {} },
        deleteQueuedMessage: { run() {} },
        listQueuedMessages: { all: () => [] },
        broadcast() {},
        importPipeline: () => pipelineGate,
        getWorkingDir: () => null,
        isMultiSessionEnabled: () => true,
    }, new SessionLanes(() => 1));

    const retryTimer = setTimeout(() => {}, 60_000);
    retryTimer.unref();
    controller.retryStateForScope('retry-scope').setTimer(retryTimer);
    assert.equal(controller.isRetryPending('retry-scope'), true);
    controller.retryStateForScope('retry-scope').setTimer(null);
    clearTimeout(retryTimer);

    controller.enqueueMessage('drain-window', 'web', { scope: 'drain-scope', chatSessionId: 'route-delete' });
    for (let i = 0; i < 20 && controller.messageQueue.length > 0; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(controller.messageQueue.length, 0, 'item was spliced before orchestration import resolved');
    assert.equal(controller.isQueueBusy('drain-scope'), true, 'drainingScopes covers the splice-to-orchestration window');

    releasePipeline({
        orchestrate: async () => {}, orchestrateContinue: async () => {}, orchestrateReset: async () => {},
        isContinueIntent: () => false, isResetIntent: () => false, drainPendingReplays: async () => {},
    });
    for (let i = 0; i < 20 && controller.isQueueBusy('drain-scope'); i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(controller.isQueueBusy('drain-scope'), false);
});

// The isolated-controller test above proves the two windows EXIST. This one
// proves the route actually consults them: it drives the PRODUCTION queue
// controller into each state and issues a real DELETE. Without it, a
// regression that disconnects hasChatSessionWork() from the production
// controller would leave both suites green.
test('DELETE consults the production retry window and refuses (409)', async () => {
    settings.multiSession.enabled = true;
    insertSession('route-retry', 938);
    db.prepare("INSERT INTO messages (role, content, cli, model, working_dir, session_id) VALUES ('user','retry','web','m',NULL,'route-retry')").run();

    const retryTimer = setTimeout(() => {}, 60_000);
    retryTimer.unref();
    const retryLane = scopeForChatSession('route-retry', undefined, isScopedQueue());
    retryStateForScope(retryLane).setTimer(retryTimer);
    try {
        assert.equal(isRetryPending(retryLane), true, 'production controller must report the retry window');
        await withServer(async baseUrl => {
            const response = await fetch(`${baseUrl}/api/chat-sessions/route-retry`, { method: 'DELETE' });
            assert.equal(response.status, 409, 'a pending retry in the session scope must block deletion');
        });
        const stillThere = db.prepare('SELECT COUNT(*) as cnt FROM chat_sessions WHERE id = ?').get('route-retry') as { cnt: number };
        assert.equal(stillThere.cnt, 1, 'refused deletion must leave the session intact');
        const msgs = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get('route-retry') as { cnt: number };
        assert.equal(msgs.cnt, 1, 'refused deletion must leave its messages intact');
    } finally {
        retryStateForScope(retryLane).setTimer(null);
        clearTimeout(retryTimer);
    }

    // With the window closed the same request must now succeed, proving the 409
    // came from the live predicate rather than an unrelated permanent block.
    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/api/chat-sessions/route-retry`, { method: 'DELETE' });
        assert.equal(response.status, 200);
    });
});

test('remotely bound sessions always return 409 with a reason', async () => {
    settings.multiSession.enabled = true;
    insertSession('route-remote', 936);
    db.prepare('INSERT INTO remote_session_bindings (remote_key, chat_session_id) VALUES (?, ?)')
        .run('jaw:telegram:group:071', 'route-remote');
    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/api/chat-sessions/route-remote`, { method: 'DELETE' });
        assert.equal(response.status, 409);
        const body = await response.json() as { reason?: string };
        assert.match(body.reason || '', /remote/i);
    });
});
