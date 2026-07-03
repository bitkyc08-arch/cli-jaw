// Batch verdict aggregation (260703 dispatch affordance) — pure-function tests.
// Conservative policy: any negative dominates; positives count only in their
// own gate state; cross-state and verdict-less batches are a no-op.
// NOTE (Opus review FINDING 2): at this layer `null` means "clean run without a
// verdict keyword" ONLY. Execution failures (crash/busy, result.ok === false)
// are handled one layer up in routes/orchestrate.ts persistBatchVerdict, which
// suppresses a POSITIVE aggregate when any worker failed to execute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBatchVerdicts } from '../../src/orchestrator/state-machine.js';

test('A-state: any fail dominates mixed pass/fail', () => {
    assert.equal(aggregateBatchVerdicts('A', ['pass', 'fail', 'pass']), 'fail');
});

test('A-state: all pass aggregates to pass', () => {
    assert.equal(aggregateBatchVerdicts('A', ['pass', 'pass']), 'pass');
});

test('A-state: nulls do not block a pass, but no verdicts is a no-op', () => {
    assert.equal(aggregateBatchVerdicts('A', [null, 'pass']), 'pass');
    assert.equal(aggregateBatchVerdicts('A', [null, null]), null);
    assert.equal(aggregateBatchVerdicts('A', []), null);
});

test('A-state: B-vocabulary verdicts are ignored (cross-state no-op)', () => {
    assert.equal(aggregateBatchVerdicts('A', ['done', 'needs_fix']), null);
});

test('B-state: any needs_fix dominates mixed done/needs_fix', () => {
    assert.equal(aggregateBatchVerdicts('B', ['done', 'needs_fix']), 'needs_fix');
});

test('B-state: all done aggregates to done', () => {
    assert.equal(aggregateBatchVerdicts('B', ['done', 'done']), 'done');
});

test('B-state: A-vocabulary verdicts are ignored (cross-state no-op)', () => {
    assert.equal(aggregateBatchVerdicts('B', ['pass', 'fail']), null);
});

test('non-gate states never aggregate', () => {
    for (const state of ['IDLE', 'I', 'P', 'C', 'D'] as const) {
        assert.equal(aggregateBatchVerdicts(state, ['pass', 'done']), null, `state ${state}`);
    }
});
