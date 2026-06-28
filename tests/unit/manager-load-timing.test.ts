import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageTimer } from '../../src/manager/load-timing.ts';

// A fake monotonic clock driven by an explicit array of readings — deterministic,
// no sleeps. Each call to now() returns the next reading.
function fakeClock(readings: number[]): () => number {
    let i = 0;
    return () => readings[Math.min(i++, readings.length - 1)]!;
}

test('stage timer records per-stage durations and a total', () => {
    // start=0, mark scan@10, mark detect@25, measure@40
    const timer = createStageTimer(fakeClock([0, 10, 25, 40]));
    timer.mark('scan');
    timer.mark('detect');
    const t = timer.measure();
    assert.equal(t.stages['scan'], 10);
    assert.equal(t.stages['detect'], 15);
    assert.equal(t.totalMs, 40);
});

test('repeated stage name accumulates rather than overwrites', () => {
    // start=0, mark a@5, mark a@12, measure@12
    const timer = createStageTimer(fakeClock([0, 5, 12, 12]));
    timer.mark('a');
    timer.mark('a');
    const t = timer.measure();
    assert.equal(t.stages['a'], 12);
});

test('a backwards clock reading never yields a negative duration', () => {
    // start=100, mark scan@80 (clock went backwards), measure@90
    const timer = createStageTimer(fakeClock([100, 80, 90]));
    timer.mark('scan');
    const t = timer.measure();
    assert.equal(t.stages['scan'], 0);
    assert.ok(t.totalMs >= 0);
});

test('durations are rounded to two decimals', () => {
    const timer = createStageTimer(fakeClock([0, 10.123456, 10.123456]));
    timer.mark('scan');
    const t = timer.measure();
    assert.equal(t.stages['scan'], 10.12);
    assert.equal(t.totalMs, 10.12);
});

test('measure with no marks returns an empty stage map and a total', () => {
    const timer = createStageTimer(fakeClock([0, 7]));
    const t = timer.measure();
    assert.deepEqual(t.stages, {});
    assert.equal(t.totalMs, 7);
});
