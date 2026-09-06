import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveClaudeRun, hasClaudeRuns, hasClaudeWorker, cancelClaudeScope, cancelClaudeWorker, cancelAllClaudeRuns } from '../../src/agent/runtime/claude-run-controls.ts';
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
