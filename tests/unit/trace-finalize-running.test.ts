import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { startTraceRun, finalizeTraceRun, getTraceRun, createTraceId, appendTraceEvent } from '../../src/trace/store.ts';

test('conditional finalization closes an owned running header', () => {
    const id = startTraceRun({ cli: 'claude', model: 'fixture', audience: 'internal' });
    appendTraceEvent({ runId: id, source: 'system', eventType: 'fixture', raw: { marker: 'owned' } });
    finalizeTraceRun(id, 'error', 'setup failed', { onlyIfRunning: true });
    const row = getTraceRun(id)!;
    assert.equal(row.status, 'error'); assert.equal(row.error, 'setup failed');
    assert.ok(row.finished_at); assert.equal(row.event_count, 1);
});

for (const status of ['done', 'error', 'interrupted'] as const) {
    test(`late conditional close preserves the complete ${status} header`, () => {
        const id = startTraceRun({ cli: 'claude', model: 'fixture', audience: 'internal' });
        appendTraceEvent({ runId: id, source: 'system', eventType: 'fixture', raw: { marker: status } });
        finalizeTraceRun(id, status, 'original error');
        db.prepare('UPDATE trace_runs SET finished_at=? WHERE id=?').run(123456789, id);
        const before = getTraceRun(id);
        finalizeTraceRun(id, 'error', 'late cleanup failure', { onlyIfRunning: true });
        assert.deepEqual(getTraceRun(id), before);
    });
}

test('unknown conditional target creates no header and does not change other runs', () => {
    const before = db.prepare('SELECT * FROM trace_runs ORDER BY id').all();
    finalizeTraceRun(createTraceId(), 'error', 'unowned', { onlyIfRunning: true });
    assert.deepEqual(db.prepare('SELECT * FROM trace_runs ORDER BY id').all(), before);
});

test('existing unconditional finalization remains available to its original callers', () => {
    const id = startTraceRun({ cli: 'claude', model: 'fixture', audience: 'internal' });
    finalizeTraceRun(id, 'done'); finalizeTraceRun(id, 'error', 'explicit existing policy');
    assert.equal(getTraceRun(id)?.status, 'error'); assert.equal(getTraceRun(id)?.error, 'explicit existing policy');
});
