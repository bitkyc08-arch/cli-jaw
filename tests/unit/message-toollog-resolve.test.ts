// ── Option D /api/messages tool_log source resolution (devlog 260620 Phase 3) ──
// resolveToolLog picks trace_events (durable, uncapped) over the messages.tool_log
// blob when the rollout flag is on AND the message has a linked trace run with tools;
// otherwise it falls back to the blob (legacy + old messages). Default OFF.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolLog } from '../../src/routes/messages.js';
import { startTraceRun, stampTraceTool, linkTraceRunToMessage } from '../../src/trace/store.js';
import { parseToolLogBounded } from '../../src/shared/tool-log-sanitize.js';

const labels = (serialized: string | null): string[] =>
    parseToolLogBounded(serialized).map((t) => t.label);

test('MTL-001: fromTrace=false → blob path (legacy default, unchanged)', () => {
    const blob = JSON.stringify([{ icon: '🔧', label: 'BlobTool' }]);
    assert.deepEqual(labels(resolveToolLog(123, blob, false)), ['BlobTool'], 'blob used when flag off');
});

test('MTL-002: fromTrace=true + linked trace run → trace cards used', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const ctx = { traceRunId: runId, traceAudience: 'public' as const };
    stampTraceTool({ icon: '🔧', label: 'TraceTool', stepRef: 'claude:tooluse:x', status: 'done', toolType: 'tool' }, ctx, 'tool');
    const messageId = 991001;
    linkTraceRunToMessage(runId, messageId);

    const blob = JSON.stringify([{ icon: '🔧', label: 'StaleBlob' }]);
    assert.deepEqual(labels(resolveToolLog(messageId, blob, true)), ['TraceTool'], 'trace overrides blob when flag on + linked');
});

test('MTL-003: fromTrace=true but no trace tools → blob fallback (old messages)', () => {
    const blob = JSON.stringify([{ icon: '🔧', label: 'OldBlob' }]);
    assert.deepEqual(labels(resolveToolLog(991999, blob, true)), ['OldBlob'], 'falls back to blob when message has no trace run');
});

test('MTL-004: invalid messageId or null blob → safe, never throws', () => {
    const blob = JSON.stringify([{ icon: '🔧', label: 'B' }]);
    assert.deepEqual(labels(resolveToolLog(0, blob, true)), ['B'], 'invalid id → blob');
    assert.deepEqual(labels(resolveToolLog(null, blob, true)), ['B'], 'null id → blob');
    assert.equal(resolveToolLog(123, null, false), null, 'null blob → null');
});

test('MTL-005: flag on preserves blob worker mirrors alongside trace boss tools (anti-regression)', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const ctx = { traceRunId: runId, traceAudience: 'public' as const };
    stampTraceTool({ icon: '🔧', label: 'BossRead', stepRef: 'claude:tooluse:b1', status: 'done', toolType: 'tool' }, ctx, 'tool');
    const messageId = 992001;
    linkTraceRunToMessage(runId, messageId);

    // blob holds the boss tool (also in trace) + a worker mirror (Phase 1 preserves isEmployee here)
    const blob = JSON.stringify([
        { icon: '🔧', label: 'BossRead', stepRef: 'claude:tooluse:b1', isEmployee: false },
        { icon: '🔧', label: 'WorkerGrep', stepRef: 'w:tooluse:1', isEmployee: true },
    ]);
    const got = labels(resolveToolLog(messageId, blob, true));
    assert.ok(got.includes('BossRead'), 'boss tool present (from trace)');
    assert.ok(got.includes('WorkerGrep'), 'worker mirror preserved from blob — NOT dropped when flag on');
    assert.equal(got.filter((l) => l === 'BossRead').length, 1, 'boss tool deduped by stepRef (trace + blob)');
});
