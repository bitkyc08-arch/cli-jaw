import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { currentSeq, replaySince } from '../../src/core/event-bus.ts';
import {
    WORKER_RUNS_DIR,
} from '../../src/orchestrator/worker-output-store.ts';
import {
    appendWorkerRunEvent,
    completeWorkerRun,
    createWorkerRunRecord,
    getWorkerRunRecord,
    listWorkerRunEvents,
    listWorkerRunRecords,
    readWorkerRunOutput,
    recordWorkerRunProgress,
} from '../../src/orchestrator/worker-run-store.ts';

test.afterEach(() => {
    rmSync(WORKER_RUNS_DIR, { recursive: true, force: true });
});

test('worker run store appends monotonic safe events and publishes worker topic events', () => {
    const mark = currentSeq();
    const runId = 'wr_backend_storetest';
    createWorkerRunRecord({
        runId,
        agentId: 'backend',
        employeeName: 'Backend',
        taskPreview: 'verify',
        startedAt: 100,
    });
    appendWorkerRunEvent(runId, 'worker_run_attention', { attention: { kind: 'stalled' } });
    recordWorkerRunProgress(runId, [{ label: 'npm test', toolType: 'tool' }]);

    const events = listWorkerRunEvents(runId);
    assert.deepEqual(events.map(event => event.seq), [1, 2, 3]);
    assert.deepEqual(events.map(event => event.event), [
        'worker_run_started',
        'worker_run_attention',
        'worker_run_progress',
    ]);

    const busEvents = replaySince(mark).filter(event => event.event.startsWith('worker_run_'));
    assert.equal(busEvents.length, 3);
    assert.ok(busEvents.every(event => event.topic === 'worker'));
    assert.ok(!JSON.stringify(busEvents).includes('raw secret output'));
});

test('worker run store keeps raw output out of safe list and get records', () => {
    const runId = 'wr_backend_rawsplit';
    createWorkerRunRecord({
        runId,
        agentId: 'backend',
        employeeName: 'Backend',
        taskPreview: 'verify',
        startedAt: 100,
    });
    completeWorkerRun(runId, 'done', 'raw secret output');

    const listed = listWorkerRunRecords()[0];
    const record = getWorkerRunRecord(runId);
    const events = listWorkerRunEvents(runId);
    const output = readWorkerRunOutput(runId, { offset: 4, limit: 6 });

    assert.equal(listed?.hasOutput, true);
    assert.equal(record?.hasOutput, true);
    assert.equal('outputFile' in (record || {}), false);
    assert.ok(!JSON.stringify(record).includes('raw secret output'));
    assert.ok(!JSON.stringify(events).includes('raw secret output'));
    assert.equal(output.text, 'secret');
});
