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
    pruneTraceEvents,
    stampTraceTool,
    startTraceRun,
    updateTraceToolRow,
} from '../../src/trace/store.ts';
import { db } from '../../src/core/db.ts';
import type { ToolEntry } from '../../src/types/agent.ts';

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

test.describe('trace retention pruning', { concurrency: false }, () => {
test('trace retention preserves message and detailRef runs while deleting an old orphan', () => {
    const messageRunId = startTraceRun({ cli: 'codex', audience: 'public' });
    const segmentRunId = startTraceRun({ cli: 'codex', audience: 'public' });
    const orphanRunId = startTraceRun({ cli: 'codex', audience: 'public' });
    const createdAt = Date.now() - 30 * 86_400_000;

    for (const runId of [messageRunId, segmentRunId, orphanRunId]) {
        appendTraceEvent({ runId, source: 'tool', eventType: 'old', raw: { runId } });
        db.prepare('UPDATE trace_runs SET started_at = ? WHERE id = ?').run(createdAt, runId);
        db.prepare('UPDATE trace_events SET created_at = ? WHERE run_id = ?').run(createdAt, runId);
    }

    const message = db.prepare(`
        INSERT INTO messages (role, content, trace_run_id, session_id)
        VALUES ('assistant', 'retention fixture', ?, 'trace-retention-test')
    `).run(messageRunId);
    db.prepare(`
        INSERT INTO turn_segments (turn_id, turn_seq, created_at, type, status, trace_run_id, trace_seq)
        VALUES (?, 1, ?, 'tool', 'done', ?, 1)
    `).run(`turn-retention-${segmentRunId}`, Date.now(), segmentRunId);

    try {
        const result = pruneTraceEvents(7, 50_000);

        assert.ok(getTraceRun(messageRunId), 'a live message protects its trace run');
        assert.equal(listTraceEvents(messageRunId).total, 1, 'message-linked trace events survive the time cutoff');
        assert.ok(getTraceRun(segmentRunId), 'a turn segment detailRef protects its trace run');
        assert.equal(listTraceEvents(segmentRunId).total, 1, 'detailRef trace events survive the time cutoff');
        assert.equal(getTraceRun(orphanRunId), null, 'an old unreferenced trace run is pruned');
        assert.equal(result.deletedRuns, 1);

        const dangling = db.prepare(`
            SELECT COUNT(*) AS count FROM (
                SELECT trace_run_id FROM messages WHERE trace_run_id IS NOT NULL
                UNION
                SELECT trace_run_id FROM turn_segments WHERE trace_run_id IS NOT NULL
            ) refs
            LEFT JOIN trace_runs ON trace_runs.id = refs.trace_run_id
            WHERE trace_runs.id IS NULL
        `).get() as { count: number };
        assert.equal(dangling.count, 0, 'message and detailRef trace references must not dangle');
    } finally {
        db.prepare('DELETE FROM messages WHERE id = ?').run(Number(message.lastInsertRowid));
        db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(`turn-retention-${segmentRunId}`);
        db.prepare('DELETE FROM trace_runs WHERE id IN (?, ?)').run(messageRunId, segmentRunId);
    }
});

test('trace retention sweeps recent events orphaned by old run deletion without touching referenced runs', () => {
    const foreignKeys = Number(db.pragma('foreign_keys', { simple: true }));
    db.pragma('foreign_keys = OFF');
    const orphanRunId = startTraceRun({ cli: 'codex', audience: 'public' });
    const protectedRunId = startTraceRun({ cli: 'codex', audience: 'public' });
    const oldStartedAt = Date.now() - 30 * 86_400_000;
    appendTraceEvent({ runId: orphanRunId, source: 'tool', eventType: 'recent', raw: 'orphan event' });
    appendTraceEvent({ runId: protectedRunId, source: 'tool', eventType: 'recent', raw: 'protected event' });
    db.prepare('UPDATE trace_runs SET started_at = ? WHERE id IN (?, ?)')
        .run(oldStartedAt, orphanRunId, protectedRunId);
    const message = db.prepare(`
        INSERT INTO messages (role, content, trace_run_id, session_id)
        VALUES ('assistant', 'orphan sweep fixture', ?, 'trace-retention-test')
    `).run(protectedRunId);

    try {
        const result = pruneTraceEvents(7, 50_000);

        assert.equal(getTraceRun(orphanRunId), null, 'old unreferenced run is deleted');
        assert.equal(listTraceEvents(orphanRunId).total, 0, 'recent event left by run pruning is swept');
        assert.equal(getTraceEvent(orphanRunId, 1), null, 'orphan event cannot be read without its parent run');
        assert.ok(getTraceRun(protectedRunId), 'referenced old run survives');
        assert.equal(listTraceEvents(protectedRunId).total, 1, 'orphan sweep leaves referenced run events intact');
        assert.equal(result.deletedRuns, 1);
        assert.ok(result.deletedEvents >= 1, 'orphan event deletion is included in the prune result');
    } finally {
        db.prepare('DELETE FROM messages WHERE id = ?').run(Number(message.lastInsertRowid));
        db.prepare('DELETE FROM trace_runs WHERE id = ?').run(protectedRunId);
        db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
});

test('maxRows trimming never removes events from referenced trace runs', () => {
    const protectedRunId = startTraceRun({ cli: 'codex', audience: 'public' });
    const orphanRunId = startTraceRun({ cli: 'codex', audience: 'public' });
    appendTraceEvent({ runId: protectedRunId, source: 'tool', eventType: 'protected', raw: 'protected' });
    appendTraceEvent({ runId: orphanRunId, source: 'tool', eventType: 'orphan', raw: 'orphan' });
    const message = db.prepare(`
        INSERT INTO messages (role, content, trace_run_id, session_id)
        VALUES ('assistant', 'maxRows fixture', ?, 'trace-retention-test')
    `).run(protectedRunId);

    try {
        pruneTraceEvents(365_000, 0);
        assert.equal(listTraceEvents(protectedRunId).total, 1, 'maxRows cap yields to live trace references');
        assert.equal(listTraceEvents(orphanRunId).total, 0, 'maxRows trims an eligible orphan event');
    } finally {
        db.prepare('DELETE FROM messages WHERE id = ?').run(Number(message.lastInsertRowid));
        db.prepare('DELETE FROM trace_runs WHERE id IN (?, ?)').run(protectedRunId, orphanRunId);
    }
});
});
