import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerManagerRuntimeMonitorRoutes } from '../../src/manager/routes/runtime-monitor.ts';
import { resetGoalStore, setGoal, updateGoal } from '../../src/goal/store.ts';
import { cancelWorker, claimWorker, markWorkerActive } from '../../src/orchestrator/worker-registry.ts';

const root = join(import.meta.dirname, '..', '..');

async function withMonitorServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    const server = http.createServer(app);
    app.use(express.json());
    registerManagerRuntimeMonitorRoutes(app, (_req, _res, next) => next());

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert.equal(typeof address, 'object');
        assert.ok(address);
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

test('manager runtime monitor routes return JSON for bgtask and worker progress', async () => {
    const agentId = `monitor-route-${Date.now()}`;
    claimWorker({ id: agentId, name: 'Monitor Route' }, 'verify manager-local monitor routes');
    markWorkerActive(agentId);

    try {
        await withMonitorServer(async (baseUrl) => {
            const bgtasks = await fetch(`${baseUrl}/api/bgtask?limit=1`);
            assert.equal(bgtasks.status, 200);
            assert.match(bgtasks.headers.get('content-type') || '', /application\/json/);
            const bgtaskBody = await bgtasks.json() as { tasks?: unknown[] };
            assert.ok(Array.isArray(bgtaskBody.tasks));

            const workers = await fetch(`${baseUrl}/api/orchestrate/worker-progress`);
            assert.equal(workers.status, 200);
            assert.match(workers.headers.get('content-type') || '', /application\/json/);
            const workerBody = await workers.json() as { ok?: boolean; workers?: Array<{ agentId: string }> };
            assert.equal(workerBody.ok, true);
            assert.ok(workerBody.workers?.some(worker => worker.agentId === agentId));

            const detail = await fetch(`${baseUrl}/api/orchestrate/worker-progress/${encodeURIComponent(agentId)}`);
            assert.equal(detail.status, 200);
            const detailBody = await detail.json() as { ok?: boolean; progress?: { agentId: string } };
            assert.equal(detailBody.ok, true);
            assert.equal(detailBody.progress?.agentId, agentId);

            const missing = await fetch(`${baseUrl}/api/orchestrate/worker-progress/missing-agent`);
            assert.equal(missing.status, 404);
            assert.match(missing.headers.get('content-type') || '', /application\/json/);
        });
    } finally {
        cancelWorker(agentId);
    }
});

test('manager runtime monitor exposes goal and PABCD status as Manager-local JSON', async () => {
    resetGoalStore();
    const goal = setGoal('Verify Manager-local Code mode status surface', {
        repoRoot: '/tmp/cli-jaw-status-test',
        replace: true,
    });
    updateGoal('status route checkpoint', 'assert runtime status JSON', ['tests/unit/manager-runtime-monitor-routes.test.ts']);

    try {
        await withMonitorServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/manager/runtime-status`);
            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') || '', /application\/json/);
            const body = await response.json() as {
                ok?: boolean;
                goal?: { id?: string; objectivePreview?: string; lastCheckpoint?: { evidencePaths?: string[] }; evidenceFreshness?: string };
                pabcd?: { state?: string; gate?: { label?: string; status?: string; evidence?: string[] } };
                runtime?: { activeWorkers?: number; pendingWorkerReplays?: boolean; heartbeatPending?: number };
            };

            assert.equal(body.ok, true);
            assert.equal(body.goal?.id, goal.id);
            assert.equal(body.goal?.objectivePreview, 'Verify Manager-local Code mode status surface');
            assert.equal(body.goal?.lastCheckpoint?.evidencePaths?.[0], 'tests/unit/manager-runtime-monitor-routes.test.ts');
            assert.equal(body.goal?.evidenceFreshness, 'fresh');
            assert.equal(typeof body.pabcd?.state, 'string');
            assert.equal(typeof body.pabcd?.gate?.label, 'string');
            assert.equal(typeof body.pabcd?.gate?.status, 'string');
            assert.ok(Array.isArray(body.pabcd?.gate?.evidence));
            assert.equal(typeof body.runtime?.activeWorkers, 'number');
            assert.equal(typeof body.runtime?.pendingWorkerReplays, 'boolean');
            assert.equal(typeof body.runtime?.heartbeatPending, 'number');
        });
    } finally {
        resetGoalStore();
    }
});

test('manager server registers monitor APIs before the SPA fallback', () => {
    const serverSrc = readFileSync(join(root, 'src/manager/server.ts'), 'utf8');
    const routeIdx = serverSrc.indexOf('registerManagerRuntimeMonitorRoutes(app');
    const fallbackIdx = serverSrc.indexOf("app.get('/{*splat}'");

    assert.ok(serverSrc.includes("import { registerManagerRuntimeMonitorRoutes } from './routes/runtime-monitor.js';"));
    assert.ok(routeIdx > 0, 'manager monitor routes must be registered');
    assert.ok(fallbackIdx > 0, 'SPA fallback must exist');
    assert.ok(routeIdx < fallbackIdx, 'monitor APIs must not fall through to manager HTML');
});
