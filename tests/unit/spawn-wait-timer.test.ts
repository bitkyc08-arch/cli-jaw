import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForProcessEnd, activeMainProcesses } from '../../src/agent/spawn.ts';
import { inferTopic } from '../../src/core/bus.ts';

// #523: waitForProcessEnd armed a deadline timer and never cleared it on the
// fast path. A child normally exits in milliseconds, so the promise resolved
// and then a live timer sat there for the rest of the budget — and unlike the
// teardown timer it is not unref'd, so it held the event loop open. The sibling
// waitForAllProcessesEnd twenty lines below already did this correctly.

function pendingTimers(): number {
    return process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
}

test('SWT-001: the fast path leaves no pending timer behind', async () => {
    const before = pendingTimers();
    activeMainProcesses.set('leak-probe', {} as never);
    const waiting = waitForProcessEnd('leak-probe', 30_000);
    setTimeout(() => activeMainProcesses.delete('leak-probe'), 120);
    await waiting;
    // Give the loop one turn to release anything that was already cleared.
    await new Promise(r => setImmediate(r));
    assert.ok(pendingTimers() <= before,
        `a resolved wait must not hold a 30s timer: before=${before} after=${pendingTimers()}`);
});

test('SWT-002: the deadline path still resolves when the child never exits', async () => {
    // The clear must not break the bound it is clearing. A wedged child has to
    // stop holding the steer, which is the whole reason the deadline exists.
    activeMainProcesses.set('wedged-probe', {} as never);
    const started = Date.now();
    await waitForProcessEnd('wedged-probe', 250);
    const elapsed = Date.now() - started;
    activeMainProcesses.delete('wedged-probe');
    assert.ok(elapsed >= 200, `the deadline must still fire, resolved in ${elapsed}ms`);
    assert.ok(elapsed < 3000, `and must not wait longer than asked, resolved in ${elapsed}ms`);
});

test('SWT-003: an already-exited scope resolves immediately', async () => {
    const before = pendingTimers();
    await waitForProcessEnd('never-registered', 30_000);
    assert.ok(pendingTimers() <= before, 'the early return must arm nothing at all');
});

test('SWT-004: steer events are filed under the agent topic, not system', () => {
    // steer_* is named after the action rather than the subsystem, so the agent_
    // prefix never caught it and every steer event was filed as `system`.
    assert.equal(inferTopic('steer_started'), 'agent');
    assert.equal(inferTopic('steer_rejected'), 'agent', 'this one was already shipped misfiled');
    assert.equal(inferTopic('steer_context_lost'), 'agent');
});

test('SWT-005: the prefix rule does not swallow unrelated types', () => {
    assert.equal(inferTopic('worker_stalled'), 'worker');
    assert.equal(inferTopic('new_message'), 'message');
    assert.equal(inferTopic('agent:claude-e:tool'), 'trace', 'the trace branch must still win');
});
