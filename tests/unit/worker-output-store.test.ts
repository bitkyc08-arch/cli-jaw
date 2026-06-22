import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
    MAX_WORKER_OUTPUT_LIMIT,
    WORKER_RUNS_DIR,
    readWorkerOutput,
    writeWorkerOutput,
} from '../../src/orchestrator/worker-output-store.ts';

test.afterEach(() => {
    rmSync(WORKER_RUNS_DIR, { recursive: true, force: true });
});

test('worker output store writes raw text and reads bounded offset chunks', () => {
    const runId = 'wr_backend_outputtest';
    const write = writeWorkerOutput(runId, 'abcdef');

    assert.equal(write.outputBytes, 6);

    const first = readWorkerOutput(runId, { offset: 1, limit: 3 });
    assert.equal(first.text, 'bcd');
    assert.equal(first.nextOffset, 4);
    assert.equal(first.eof, false);

    const second = readWorkerOutput(runId, { offset: 4, limit: 30 });
    assert.equal(second.text, 'ef');
    assert.equal(second.nextOffset, 6);
    assert.equal(second.eof, true);
});

test('worker output store caps oversized read limits', () => {
    const runId = 'wr_backend_limitcap';
    writeWorkerOutput(runId, 'x'.repeat(MAX_WORKER_OUTPUT_LIMIT + 10));

    const read = readWorkerOutput(runId, { limit: MAX_WORKER_OUTPUT_LIMIT * 2 });
    assert.equal(read.text.length, MAX_WORKER_OUTPUT_LIMIT);
    assert.equal(read.limit, MAX_WORKER_OUTPUT_LIMIT);
    assert.equal(read.eof, false);
});

test('worker output store rejects unsafe run ids', () => {
    assert.throws(() => writeWorkerOutput('../bad', 'nope'), /invalid worker run id/);
});
