// Snapshots converge from durable rows even at equal counts, preserving RAM fallback.
import '../setup/test-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerOrchestrateRoutes } from '../../src/routes/orchestrate.ts';
import { registerMessageRoutes } from '../../src/routes/messages.ts';
import { db } from '../../src/core/db.ts';
import { startTraceRun, stampTraceTool, updateTraceToolRow, countToolTraceRows, pruneTraceEvents } from '../../src/trace/store.ts';
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

// Intentionally replaces the old equal-count => RAM-label-wins expectation.
// Equal row counts do not prove freshness: updateTraceToolRow changes the existing SQL row.
// This strengthens the behavioral oracle: assert durable terminal status, updated detail,
// and an explicit detail clear through the snapshot route, while the row count stays one.
test('snapshot observes equal-count durable terminal and detail updates', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    beginLiveRun(SCOPE, 'claude');
    setLiveRunTraceId(SCOPE, runId);
    const tool: ToolEntry = { icon: '🔧', label: 'working', toolType: 'tool', status: 'running', detail: 'started' };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' }, 'tool');
    appendLiveRunTool(SCOPE, { ...tool, label: 'ram-version' });
    updateTraceToolRow({ ...tool, label: 'finished', status: 'done', detail: 'result' });
    assert.equal(countToolTraceRows(runId), 1, 'completion updates the same SQL row');

    const activeRun = await fetchActiveRun();
    assert.deepEqual(activeRun.toolLog.map(t => [t.label, t.status, t.detail]), [['finished', 'done', 'result']]);
    updateTraceToolRow({ ...tool, label: 'finished', status: 'done', detail: '' });
    const cleared = await fetchActiveRun();
    assert.equal(cleared.toolLog.length, 1);
    assert.equal(cleared.toolLog[0]?.detail ?? '', '', 'empty durable detail must not resurrect stale RAM detail');
    clearLiveRun(SCOPE);
});

test('snapshot keeps all RAM tools when storage has no rows or only some rows', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    beginLiveRun(SCOPE, 'claude');
    setLiveRunTraceId(SCOPE, runId);
    appendLiveRunTool(SCOPE, { icon: '🔧', label: 'unstored-boss', toolType: 'tool', stepRef: 'lost' });
    appendLiveRunTool(SCOPE, { icon: '🤖', label: 'unstored-worker', toolType: 'tool', isEmployee: true });
    assert.equal(countToolTraceRows(runId), 0);
    assert.deepEqual((await fetchActiveRun()).toolLog.map(t => t.label), ['unstored-boss', 'unstored-worker']);
    seedTraceTools(runId, ['stored-boss']);
    assert.deepEqual((await fetchActiveRun()).toolLog.map(t => t.label), ['stored-boss', 'unstored-boss', 'unstored-worker']);
    setLiveRunTraceId(SCOPE, 'tr_missing000000000000000000');
    assert.deepEqual((await fetchActiveRun()).toolLog.map(t => t.label), ['unstored-boss', 'unstored-worker']);
    clearLiveRun(SCOPE);
});

test('snapshot preserves cross-run and unscoped workers with the boss stepRef', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const workerRunId = startTraceRun({ cli: 'claude', audience: 'internal' });
    const boss: ToolEntry = { icon: '🔧', label: 'boss', toolType: 'tool', stepRef: 'shared', status: 'done' };
    stampTraceTool(boss, { traceRunId: runId, traceAudience: 'public' });
    beginLiveRun(SCOPE, 'claude');
    setLiveRunTraceId(SCOPE, runId);
    appendLiveRunTool(SCOPE, { ...boss, label: 'stale-boss', status: 'running' });
    appendLiveRunTool(SCOPE, { ...boss, traceRunId: workerRunId, label: 'worker', isEmployee: true });
    appendLiveRunTool(SCOPE, { icon: '🤖', label: 'unknown-worker', toolType: 'tool', stepRef: 'shared', isEmployee: true });
    const tools = (await fetchActiveRun()).toolLog;
    assert.deepEqual(tools.map(t => t.label), ['boss', 'worker', 'unknown-worker']);
    assert.equal(tools[0]?.status, 'done');
    clearLiveRun(SCOPE);
});

test('snapshot reads only the latest 400 durable rows before applying inline caps', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    seedTraceTools(runId, Array.from({ length: 405 }, (_, i) => `boss-${i + 1}`));
    beginLiveRun(SCOPE, 'claude');
    setLiveRunTraceId(SCOPE, runId);
    const tools = (await fetchActiveRun()).toolLog;
    assert.equal(tools.length, 160);
    assert.equal(tools[0]?.label, '241 tool events omitted', 'inline cap saw 400 rows, not the whole run');
    assert.equal(tools[1]?.label, 'boss-247');
    assert.equal(tools.at(-1)?.label, 'boss-405');
    clearLiveRun(SCOPE);
});

test('snapshot recalculates one omission marker for 161 durable tools and preserves it without DB rows', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    beginLiveRun(SCOPE, 'claude');
    for (let seq = 1; seq <= 161; seq++) {
        const tool: ToolEntry = { icon: '🔧', label: `boss-${seq}`, toolType: 'tool', status: 'done' };
        stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' });
        appendLiveRunTool(SCOPE, tool);
    }
    assert.equal(countToolTraceRows(runId), 161);
    const newestSequences = Array.from({ length: 159 }, (_, i) => i + 3);
    // With no durable rows, the RAM marker still accounts for its two evicted tools.
    setLiveRunTraceId(SCOPE, 'tr_missing000000000000000000');
    const fallback = (await fetchActiveRun()).toolLog;
    assert.equal(fallback.length, 160);
    assert.equal(fallback[0]?.label, '2 tool events omitted');
    assert.deepEqual(fallback.slice(1).map(t => t.traceSeq), newestSequences);

    // Reconstructing from all durable tools must replace, not append, the RAM marker.
    setLiveRunTraceId(SCOPE, runId);
    const reconstructed = (await fetchActiveRun()).toolLog;
    assert.equal(reconstructed.length, 160);
    assert.equal(reconstructed.filter(t => t.traceSeq === undefined).length, 1, 'exactly one omission marker');
    assert.equal(reconstructed[0]?.label, '2 tool events omitted');
    assert.deepEqual(reconstructed.slice(1).map(t => t.traceSeq), newestSequences, 'all 159 newest real tools survive');
    clearLiveRun(SCOPE);
});

test('actual messages API bounds a legacy tool blob before sending it to clients', async () => {
    const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ icon: 'x', label: `raw-${i}`,
        toolType: 'tool', stepRef: `raw-${i}`, detail: 'x'.repeat(600) })));
    const id = Number(db.prepare("INSERT INTO messages(role,content,session_id,tool_log) VALUES('assistant','fixture','default',?)").run(raw).lastInsertRowid);
    const app = express(); registerMessageRoutes(app, noAuth);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/messages?session=default`, { signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        const body = await response.json() as { data: Array<{ id: number; tool_log: string }> };
        const row = body.data.find(message => message.id === id)!;
        assert.ok(row.tool_log.length <= 64_000); assert.notEqual(row.tool_log, raw);
        const tools = JSON.parse(row.tool_log) as Array<{ label: string }>;
        assert.ok(tools.length <= 160); assert.equal(tools.at(-1)?.label, 'raw-199');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('partial retention cannot erase a known RAM omission when only one durable tool survives', async () => {
    clearLiveRun(SCOPE);
    const runId = startTraceRun({ cli: 'claude', audience: 'public', sessionId: 'default', scopeKey: SCOPE });
    beginLiveRun(SCOPE, 'claude'); setLiveRunTraceId(SCOPE, runId);
    for (let seq = 1; seq <= 161; seq++) {
        const tool: ToolEntry = { icon: 'x', label: `retained-${seq}`, toolType: 'tool', status: 'running' };
        stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' });
        appendLiveRunTool(SCOPE, tool);
        if (seq === 161) updateTraceToolRow({ ...tool, status: 'done', detail: 'latest result' });
    }
    pruneTraceEvents(7, 1);
    assert.equal(countToolTraceRows(runId), 1, 'exercise real retention, not a mocked empty read');
    try {
        const tools = (await fetchActiveRun()).toolLog;
        assert.equal(tools.length, 160);
        assert.equal(tools[0]?.label, '2 tool events omitted');
        assert.equal(new Set(tools.slice(1).map(tool => tool.traceSeq)).size, 159);
        const terminal = tools.find(tool => tool.traceSeq === 161)!;
        assert.equal(terminal.status, 'done'); assert.equal(terminal.detail, 'latest result');
        assert.deepEqual((await fetchActiveRun()).toolLog, tools, 'repeated hydration cannot inflate known loss');
    } finally { clearLiveRun(SCOPE); }
});
