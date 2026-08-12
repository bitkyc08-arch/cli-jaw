// #312: Settings stuck on "상태 확인 중" because /api/cli-status was read once.
//
// The bounds matter more than the polling: a read forks a worker that runs real
// CLI probes, so an unbounded loop would be a resource bug, and a bound that
// expires silently would just restore the original stuck notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CLI_STATUS_MAX_ATTEMPTS,
    CLI_STATUS_MIN_DELAY_MS,
    CLI_STATUS_MAX_DELAY_MS,
    CLI_STATUS_POLL_HORIZON_MS,
    nextCliStatusPollDelay,
    planCliStatusPoll,
    shouldPollCliStatus,
} from '../../public/manager/src/settings/cli-status-polling.ts';

const snap = (state: string, extra: Record<string, unknown> = {}) =>
    ({ codex: { probeState: state as never, ...extra } });

test('CSP-001: keeps polling while the selected CLI is checking', () => {
    assert.equal(shouldPollCliStatus(snap('checking'), 'codex'), true);
});

test('CSP-002: fresh and stale are terminal', () => {
    assert.equal(shouldPollCliStatus(snap('fresh'), 'codex'), false);
    assert.equal(shouldPollCliStatus(snap('stale'), 'codex'), false);
});

test('CSP-003: failing is NOT terminal', () => {
    // The cache only resumes probing on the next read after its backoff
    // expires. Stopping here would replace one permanent notice with another
    // and never observe the recovery.
    assert.equal(shouldPollCliStatus(snap('failing'), 'codex'), true);
});

test('CSP-004: does not poll for an unselected, unknown, or empty CLI', () => {
    assert.equal(shouldPollCliStatus(snap('checking'), 'claude'), false);
    assert.equal(shouldPollCliStatus({}, 'codex'), false);
    assert.equal(shouldPollCliStatus(snap('checking'), ''), false);
    assert.equal(shouldPollCliStatus(null, 'codex'), false);
    assert.equal(shouldPollCliStatus(undefined, undefined), false);
});

test('CSP-005: delay grows monotonically between the floor and the ceiling', () => {
    let previous = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const delay = nextCliStatusPollDelay(attempt);
        assert.ok(delay >= CLI_STATUS_MIN_DELAY_MS, `attempt ${attempt} went under the floor`);
        assert.ok(delay <= CLI_STATUS_MAX_DELAY_MS, `attempt ${attempt} went over the ceiling`);
        assert.ok(delay >= previous, 'delay must never shrink');
        previous = delay;
    }
    // A read can fork a worker running real CLI probes; sub-second polling
    // would be a resource bug.
    assert.equal(nextCliStatusPollDelay(0), CLI_STATUS_MIN_DELAY_MS);
    assert.equal(nextCliStatusPollDelay(-5), CLI_STATUS_MIN_DELAY_MS);
});

test('CSP-006: the horizon outlives the 60s worker timeout', () => {
    // WORKER_OUTER_TIMEOUT_MS is 60_000; a shorter horizon would report a
    // healthy slow probe as a timeout.
    assert.ok(CLI_STATUS_POLL_HORIZON_MS > 60_000 + CLI_STATUS_MAX_DELAY_MS);
});

test('CSP-007: settled state stops before either bound is consulted', () => {
    const plan = planCliStatusPoll({
        snapshot: snap('fresh'), cli: 'codex', attempts: 99, now: 10_000, deadline: 0,
    });
    assert.equal(plan.kind, 'stop');
});

test('CSP-008: the wall-clock deadline ends the poll', () => {
    const plan = planCliStatusPoll({
        snapshot: snap('checking'), cli: 'codex', attempts: 0, now: 5_000, deadline: 5_000,
    });
    assert.equal(plan.kind, 'exhausted');
});

test('CSP-009: the request cap ends the poll independently of the clock', () => {
    const plan = planCliStatusPoll({
        snapshot: snap('checking'),
        cli: 'codex',
        attempts: CLI_STATUS_MAX_ATTEMPTS,
        now: 0,
        deadline: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(plan.kind, 'exhausted');
});

test('CSP-010: a server backoff delays the next read instead of firing early', () => {
    const plan = planCliStatusPoll({
        snapshot: snap('failing', { nextRetryAt: 30_000 }),
        cli: 'codex',
        attempts: 1,
        now: 10_000,
        deadline: 90_000,
    });
    assert.deepEqual(plan, { kind: 'wait', delayMs: 20_000 });
});

test('CSP-011: a backoff past the deadline waits to the deadline, not beyond', () => {
    // Otherwise the timer outlives the bound it was supposed to respect.
    const plan = planCliStatusPoll({
        snapshot: snap('failing', { nextRetryAt: 500_000 }),
        cli: 'codex',
        attempts: 1,
        now: 10_000,
        deadline: 90_000,
    });
    assert.deepEqual(plan, { kind: 'wait', delayMs: 80_000 });
});

test('CSP-012: a stale backoff in the past does not schedule a negative delay', () => {
    const plan = planCliStatusPoll({
        snapshot: snap('failing', { nextRetryAt: 1_000 }),
        cli: 'codex',
        attempts: 0,
        now: 10_000,
        deadline: 90_000,
    });
    assert.equal(plan.kind, 'wait');
    assert.ok(plan.kind === 'wait' && plan.delayMs >= CLI_STATUS_MIN_DELAY_MS);
});
