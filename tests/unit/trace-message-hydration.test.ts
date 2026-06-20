// ── Option D boss-message hydration from trace_events (devlog 260620 Phase 3) ──
// Verifies listToolEntriesForMessage: a finished assistant message's tool cards are
// reconstructed from the durable, uncapped trace_events (joined by message_id) instead
// of the lossy messages.tool_log blob. Boss runs are message-linked today
// (lifecycle-handler.ts:524); worker child runs fold in via parent_run_id once Phase 2's
// cross-process linkage lands. Audience-filtered so internal worker noise stays hidden.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    startTraceRun,
    stampTraceTool,
    linkTraceRunToMessage,
    listToolEntriesForMessage,
} from '../../src/trace/store.js';

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
    assert.equal(listToolEntriesForMessage(messageId, { audience: 'internal' }).length, 1, 'internal audience sees it');
});
