import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveClaudeRun, hasClaudeRuns, hasClaudeMainRuns, hasClaudeWorker, cancelClaudeScope, cancelClaudeWorker, cancelAllClaudeRuns } from '../../src/agent/runtime/claude-run-controls.ts';
test('pending worker reservation is cancellable and stays busy until actual completion', async () => {
    const cancelled: string[] = [];
    const run = reserveClaudeRun({ runId: 'r1', scope: 's1', workerId: 'worker1', cancel: reason => cancelled.push(reason) });
    try {
        assert.ok(hasClaudeWorker('worker1')); assert.throws(() => reserveClaudeRun({ runId: 'r2', scope: 's2', workerId: 'worker1', cancel() {} }));
        assert.equal(cancelClaudeWorker('worker1', 'stop'), true); assert.deepEqual(cancelled, ['stop']);
        assert.ok(hasClaudeRuns('s1')); run.finish(); await run.done; assert.equal(hasClaudeWorker('worker1'), false);
    } finally { run.finish(); }
});
test('scoped steer preserves workers, scoped stop and global shutdown remain exact', () => {
    const cancelled: string[] = [];
    const all = [reserveClaudeRun({ runId: 'main', scope: 's1', cancel: () => cancelled.push('main') }),
        reserveClaudeRun({ runId: 'w1', scope: 's1', workerId: 'w1', cancel: () => cancelled.push('w1') }),
        reserveClaudeRun({ runId: 'w2', scope: 's2', workerId: 'w2', cancel: () => cancelled.push('w2') })];
    try {
        cancelClaudeScope('s1', 'steer', false); assert.deepEqual(cancelled, ['main']);
        cancelled.length = 0; cancelClaudeScope('s1', 'user', true); assert.deepEqual(cancelled, ['main', 'w1']);
        cancelled.length = 0; cancelAllClaudeRuns('shutdown'); assert.deepEqual(cancelled, ['main', 'w1', 'w2']);
    } finally { for (const run of all) run.finish(); }
    assert.equal(hasClaudeRuns(), false);
});

test('main-only presence preserves retained main accounting but excludes same-scope workers and other scopes', async () => {
    const main = reserveClaudeRun({ runId: 'main-A', scope: 'A', cancel() {} });
    const worker = reserveClaudeRun({ runId: 'worker-A', scope: 'A', workerId: 'worker-A', cancel() {} });
    const otherMain = reserveClaudeRun({ runId: 'main-B', scope: 'B', cancel() {} });
    const otherWorker = reserveClaudeRun({ runId: 'worker-B', scope: 'B', workerId: 'worker-B', cancel() {} });
    try {
        assert.equal(hasClaudeMainRuns('A'), true); assert.equal(hasClaudeMainRuns('B'), true);
        assert.equal(hasClaudeMainRuns('absent'), false);
        // Cancellation is not physical completion: the captured main reservation stays counted.
        cancelClaudeScope('A', 'steer', false);
        assert.equal(hasClaudeMainRuns('A'), true);
        main.finish(); await main.done; main.finish();
        assert.equal(hasClaudeMainRuns('A'), false); assert.equal(hasClaudeRuns('A'), true);
        assert.equal(hasClaudeWorker('worker-A'), true); assert.equal(hasClaudeMainRuns('B'), true);
        otherMain.finish(); await otherMain.done;
        assert.equal(hasClaudeMainRuns('B'), false); assert.equal(hasClaudeRuns('B'), true);
    } finally { for (const run of [main, worker, otherMain, otherWorker]) run.finish(); }
    assert.equal(hasClaudeRuns(), false);
});
