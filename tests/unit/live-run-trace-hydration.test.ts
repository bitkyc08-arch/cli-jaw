// WP4 (devlog 260703 doc 12): /api/orchestrate/snapshot falls back to durable
// trace_events tool rows when the in-RAM live-run toolLog is empty or behind,
// preserves RAM-only isEmployee mirrors, and passes RAM through untouched when
// it is healthy. Route-level harness per tests/unit/trace-routes.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerOrchestrateRoutes } from '../../src/routes/orchestrate.ts';
import { startTraceRun, stampTraceTool } from '../../src/trace/store.ts';
import { beginLiveRun, setLiveRunTraceId, appendLiveRunTool, clearLiveRun } from '../../src/agent/live-run-state.ts';
import type { ToolEntry } from '../../src/types/agent.ts';

const SCOPE = 'default'; // resolveOrcScope always returns 'default' today

function noAuth(_req: Request, _res: Response, next: NextFunction): void {
    next();
}

type SnapshotToolLog = { toolLog: ToolEntry[]; running: boolean; traceRunId?: string };

async function fetchActiveRun(): Promise<SnapshotToolLog> {
    const app = express();
    registerOrchestrateRoutes(app, noAuth);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        const res = await fetch(`http://127.0.0.1:${address.port}/api/orchestrate/snapshot`);
        assert.equal(res.status, 200);
        const body = await res.json() as { activeRun: SnapshotToolLog };
        return body.activeRun;
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

function seedTraceTools(runId: string, labels: string[]): void {
    for (const label of labels) {
        const tool: ToolEntry = { icon: '🔧', label, toolType: 'tool', status: 'done' };
        stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' }, 'tool');
    }
}

test('snapshot hydrates activeRun.toolLog from trace_events when RAM is empty', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    seedTraceTools(runId, ['boss-1', 'boss-2', 'boss-3']);
    beginLiveRun(SCOPE, 'claude');
    setLiveRunTraceId(SCOPE, runId);

    const activeRun = await fetchActiveRun();
    assert.equal(activeRun.running, true);
    assert.deepEqual(activeRun.toolLog.map(t => t.label), ['boss-1', 'boss-2', 'boss-3']);
    assert.deepEqual(activeRun.toolLog.map(t => t.traceSeq), [1, 2, 3]);
    assert.ok(activeRun.toolLog.every(t => t.traceRunId === runId));
    clearLiveRun(SCOPE);
});

test('snapshot hydration preserves RAM-only isEmployee mirror entries', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    seedTraceTools(runId, ['boss-1', 'boss-2']);
    beginLiveRun(SCOPE, 'claude');
    setLiveRunTraceId(SCOPE, runId);
    appendLiveRunTool(SCOPE, { icon: '🤖', label: 'worker-progress', toolType: 'tool', isEmployee: true });

    const activeRun = await fetchActiveRun();
    const labels = activeRun.toolLog.map(t => t.label);
    assert.deepEqual(labels, ['boss-1', 'boss-2', 'worker-progress']);
    assert.equal(activeRun.toolLog[2]?.isEmployee, true);
    clearLiveRun(SCOPE);
});

test('snapshot passes the RAM toolLog through when RAM is healthy (no fallback)', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    beginLiveRun(SCOPE, 'claude');
    setLiveRunTraceId(SCOPE, runId);
    // One trace row and one RAM entry with a DIFFERENT label: counts are equal, so
    // hydration must NOT replace RAM — the RAM version is what the snapshot returns.
    const tool: ToolEntry = { icon: '🔧', label: 'trace-version', toolType: 'tool' };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' }, 'tool');
    appendLiveRunTool(SCOPE, { ...tool, label: 'ram-version' });

    const activeRun = await fetchActiveRun();
    assert.deepEqual(activeRun.toolLog.map(t => t.label), ['ram-version']);
    clearLiveRun(SCOPE);
});
