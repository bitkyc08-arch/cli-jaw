// ── Option D boss-message hydration from trace_events (devlog 260620 Phase 3) ──
// Verifies listToolEntriesForMessage: a finished assistant message's tool cards are
// reconstructed from the durable, uncapped trace_events (joined by message_id) instead
// of the lossy messages.tool_log blob. Boss runs are message-linked today
// (lifecycle-handler.ts:524); worker child runs fold in via parent_run_id once Phase 2's
// cross-process linkage lands. Audience-filtered so internal worker noise stays hidden.

import '../setup/test-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    startTraceRun,
    stampTraceTool,
    linkTraceRunToMessage,
    listToolEntriesForMessage,
    appendTraceEvent,
    getTraceEvent,
    updateTraceToolRow,
} from '../../src/trace/store.js';
import { resolveToolLog } from '../../src/routes/messages.js';
import type { ToolEntry } from '../../src/types/agent.js';

test('P3H-001: boss message tools hydrate from trace_events by message_id, in seq order', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const ctx = { traceRunId: runId, traceAudience: 'public' as const };
    stampTraceTool({ icon: '🔧', label: 'Read', stepRef: 'claude:tooluse:t1', status: 'done', toolType: 'tool' }, ctx, 'tool');
    stampTraceTool({ icon: '🔧', label: 'Grep', stepRef: 'claude:tooluse:t2', status: 'done', toolType: 'tool' }, ctx, 'tool');
    stampTraceTool({ icon: '🤖', label: 'subagent', stepRef: 'claude:tooluse:t3', status: 'done', toolType: 'subagent' }, ctx, 'subagent');
    const messageId = 990101;
    linkTraceRunToMessage(runId, messageId);

    const tools = listToolEntriesForMessage(messageId);
    assert.deepEqual(tools.map((t) => t.label), ['Read', 'Grep', 'subagent'], 'all stamped tools recovered in seq order');
    assert.equal(tools[0]?.stepRef, 'claude:tooluse:t1', 'full ToolEntry round-trips (stepRef preserved)');
    assert.equal(tools[2]?.toolType, 'subagent', 'toolType preserved');
});

test('P3H-002: unlinked or invalid message hydrates to empty (never throws)', () => {
    assert.deepEqual(listToolEntriesForMessage(990199), [], 'no linked run → empty');
    assert.deepEqual(listToolEntriesForMessage(0), [], 'invalid id → empty');
    assert.deepEqual(listToolEntriesForMessage(-5), [], 'negative id → empty');
});

test('P3H-003: public hydration excludes internal-audience (worker) runs', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'internal' });
    const ctx = { traceRunId: runId, traceAudience: 'internal' as const };
    stampTraceTool({ icon: '🔧', label: 'worker-internal', stepRef: 'w:t1', status: 'done', toolType: 'tool' }, ctx, 'tool');
    const messageId = 990301;
    linkTraceRunToMessage(runId, messageId);

    assert.deepEqual(listToolEntriesForMessage(messageId, { audience: 'public' }), [], 'internal run excluded from public hydration');
    const internal = listToolEntriesForMessage(messageId, { audience: 'internal' });
    assert.equal(internal.length, 1, 'internal audience sees it');
    assert.equal(internal[0]?.traceRunId, runId);
    assert.equal(internal[0]?.traceSeq, 1);
    assert.equal(internal[0]?.detailAvailable, false);
    assert.equal(internal[0]?.rawRetentionStatus, 'internal');
});

test('message hydration synthesizes noncontiguous pointers and current SQL detail metadata', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    appendTraceEvent({ runId, source: 'cli_raw', eventType: 'text', raw: 'between tools' });
    const tool: ToolEntry = { icon: '🔧', label: 'read', toolType: 'tool', detail: 'initial' };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' });
    linkTraceRunToMessage(runId, 990401);
    const initial = listToolEntriesForMessage(990401)[0]!;
    assert.equal(initial.traceRunId, runId);
    assert.equal(initial.traceSeq, 2);
    assert.equal(initial.detailAvailable, true);
    assert.equal(initial.detailBytes, getTraceEvent(runId, 2)?.bytes);
    assert.equal(initial.rawRetentionStatus, 'available');
    updateTraceToolRow({ ...tool, status: 'done', detail: 'a much longer completed result' });
    const updated = listToolEntriesForMessage(990401)[0]!;
    assert.equal(updated.status, 'done');
    assert.equal(updated.detail, 'a much longer completed result');
    assert.equal(updated.detailBytes, getTraceEvent(runId, 2)?.bytes, 'SQL bytes replace the stale pointer embedded in raw JSON');
    assert.notEqual(updated.detailBytes, initial.detailBytes);
    updateTraceToolRow({ ...tool, status: 'done', detail: 'x'.repeat(100_000) });
    const spilled = listToolEntriesForMessage(990401)[0]!;
    assert.equal(spilled.rawRetentionStatus, 'spilled');
    assert.equal(spilled.detailBytes, getTraceEvent(runId, 2)?.bytes);
    assert.equal(spilled.detail?.length, 100_000);
});

test('resolveToolLog preserves boss-first ordering and cross-run/unscoped blob workers', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const otherRunId = startTraceRun({ cli: 'claude', audience: 'public' });
    const workerRunId = startTraceRun({ cli: 'claude', audience: 'internal' });
    const tool: ToolEntry = { icon: '🔧', label: 'boss', toolType: 'tool', stepRef: 'shared', status: 'running', detail: 'old' };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' });
    updateTraceToolRow({ ...tool, status: 'done', detail: '' });
    stampTraceTool({ ...tool, label: 'other-boss', traceRunId: undefined, traceSeq: undefined }, { traceRunId: otherRunId, traceAudience: 'public' });
    linkTraceRunToMessage(runId, 990501);
    linkTraceRunToMessage(otherRunId, 990501);
    const blob = JSON.stringify([
        { ...tool, label: 'blob-boss' },
        { ...tool, traceRunId: workerRunId, label: 'worker-start', isEmployee: true },
        { ...tool, traceRunId: workerRunId, label: 'worker-done', status: 'done', isEmployee: true },
        { ...tool, traceRunId: undefined, label: 'unscoped-worker', isEmployee: true },
        { icon: '🤖', label: 'anonymous-worker', isEmployee: true },
    ]);
    const result = JSON.parse(resolveToolLog(990501, blob, true)!) as ToolEntry[];
    assert.deepEqual(result.slice(0, 2).map(t => t.traceRunId).sort(), [runId, otherRunId].sort());
    assert.deepEqual(result.slice(2).map(t => t.label), ['worker-done', 'unscoped-worker', 'anonymous-worker']);
    const boss = result.find(t => t.traceRunId === runId)!;
    assert.equal(boss.status, 'done');
    assert.equal(boss.detail ?? '', '');
    assert.equal(boss.traceSeq, 1);
    assert.equal((JSON.parse(resolveToolLog(990501, blob, false)!) as ToolEntry[])[0]?.label, 'blob-boss');
    assert.equal(resolveToolLog(990599, blob, true), resolveToolLog(990599, blob, false), 'missing rows retain legacy blob fallback');
});
