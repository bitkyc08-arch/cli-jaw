import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import {
    appendTraceEvent,
    countToolTraceRows,
    finalizeTraceRun,
    getTraceEvent,
    getTraceRun,
    listToolEntriesForRun,
    listTraceEvents,
    stampTraceTool,
    startTraceRun,
    updateTraceToolRow,
} from '../../src/trace/store.ts';
import type { ToolEntry } from '../../src/types/agent.ts';

test('conditional trace close settles running only and preserves every selected terminal', () => {
    const pending = startTraceRun({ cli: 'cursor', audience: 'public' });
    finalizeTraceRun(pending, 'error', 'setup failed', { onlyIfRunning: true });
    assert.equal(getTraceRun(pending)?.status, 'error');
    assert.equal(getTraceRun(pending)?.error, 'setup failed');
    for (const status of ['done', 'error', 'interrupted'] as const) {
        const id = startTraceRun({ cli: 'cursor', audience: 'public' });
        finalizeTraceRun(id, status, 'selected');
        const before = getTraceRun(id);
        finalizeTraceRun(id, 'error', 'late cleanup', { onlyIfRunning: true });
        assert.deepEqual(getTraceRun(id), before);
    }
    const unconditional = startTraceRun({ cli: 'cursor', audience: 'public' });
    finalizeTraceRun(unconditional, 'done'); finalizeTraceRun(unconditional, 'error', 'legacy');
    assert.equal(getTraceRun(unconditional)?.status, 'error');
});

test('trace store records redacted raw events, spills large payloads, and stamps tool pointers', () => {
    const runId = startTraceRun({
        cli: 'codex',
        model: 'gpt-test',
        workingDir: '/tmp/project',
        agentLabel: 'main',
        audience: 'public',
    });

    const first = appendTraceEvent({
        runId,
        source: 'cli_raw',
        eventType: 'item.started',
        raw: { type: 'item.started', headers: { authorization: 'Bearer secret-token-1234567890' } },
    });
    const large = appendTraceEvent({
        runId,
        source: 'cli_raw',
        eventType: 'large',
        raw: { text: 'x'.repeat(140_000) },
    });
    const tool: ToolEntry = { icon: '🔧', label: 'exec', toolType: 'tool', detail: 'full detail' };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' }, 'tool');
    finalizeTraceRun(runId, 'done');

    assert.equal(first?.traceRunId, runId);
    assert.equal(large?.rawRetentionStatus, 'spilled');
    assert.equal(tool.traceRunId, runId);
    assert.equal(tool.detailAvailable, true);

    const page = listTraceEvents(runId, 0, 10);
    assert.equal(page.total, 3);
    const raw = getTraceEvent(runId, 1);
    assert.ok(raw?.raw.includes('[REDACTED]'));
    assert.ok(!raw?.raw.includes('secret-token-1234567890'));
    const run = getTraceRun(runId);
    assert.equal(run?.status, 'done');
    assert.equal(run?.event_count, 3);
});

test('internal trace tool pointers are stored but not marked as detail-available', () => {
    const runId = startTraceRun({ cli: 'copilot', audience: 'internal' });
    const tool: ToolEntry = { icon: '💭', label: 'internal thought', toolType: 'thinking', detail: 'hidden' };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'internal' }, 'thinking');

    assert.equal(tool.traceRunId, runId);
    assert.equal(tool.detailAvailable, false);
    assert.equal(tool.rawRetentionStatus, 'internal');
});

// ─── WP4 (devlog 260703 doc 12): tool-row convergence + live-run hydration ───

test('tool rows converge in place and hydrate with synthesized pointers', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const tool: ToolEntry = { icon: '🔧', label: 'Bash', toolType: 'tool', status: 'running', stepRef: 'claude:tooluse:tu_a' };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' }, 'tool');
    assert.equal(countToolTraceRows(runId), 1);

    tool.status = 'done';
    tool.icon = '✅';
    tool.detail = 'exit 0';
    updateTraceToolRow(tool);

    assert.equal(countToolTraceRows(runId), 1, 'update must converge the row, not append');
    const entries = listToolEntriesForRun(runId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, 'done');
    assert.equal(entries[0]?.icon, '✅');
    assert.equal(entries[0]?.detail, 'exit 0');
    assert.equal(entries[0]?.traceRunId, runId);
    assert.equal(entries[0]?.traceSeq, tool.traceSeq);
    assert.equal(entries[0]?.detailAvailable, true);
});

test('updateTraceToolRow unlinks the stale spill file when the payload shrinks inline', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    const tool: ToolEntry = { icon: '🔧', label: 'big', toolType: 'tool', detail: 'x'.repeat(140_000) };
    stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' }, 'tool');
    assert.ok(tool.traceSeq);

    const before = getTraceEvent(runId, tool.traceSeq!);
    assert.equal(before?.retention_status, 'spilled');
    assert.ok(before?.raw_path, 'oversized payload must spill to disk');
    const spillAbs = nodePath.join(process.env['CLI_JAW_HOME'] || '', before!.raw_path!);
    assert.ok(nodeFs.existsSync(spillAbs), 'spill file exists before update');

    tool.detail = 'small';
    updateTraceToolRow(tool);

    const after = getTraceEvent(runId, tool.traceSeq!);
    assert.equal(after?.retention_status, 'available');
    assert.ok(!after?.raw_path, 'shrunk payload stores inline');
    assert.ok(after?.raw.includes('small'));
    assert.ok(!nodeFs.existsSync(spillAbs), 'stale spill file must be unlinked');
});

test('listToolEntriesForRun keeps the NEWEST rows when over the limit', () => {
    const runId = startTraceRun({ cli: 'claude', audience: 'public' });
    for (let i = 1; i <= 5; i++) {
        const tool: ToolEntry = { icon: '🔧', label: `tool-${i}`, toolType: 'tool' };
        stampTraceTool(tool, { traceRunId: runId, traceAudience: 'public' }, 'tool');
    }
    const entries = listToolEntriesForRun(runId, 3);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(e => e.label), ['tool-3', 'tool-4', 'tool-5']);
    assert.deepEqual(entries.map(e => e.traceSeq), [3, 4, 5]);
});
