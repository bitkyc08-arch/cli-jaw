// Cycle 1 (devlog/_plan/260821_agbrowse_webai_parity2/010 slice 1.1):
// the deadline must be real even when a probe never settles, and the token
// must let a mid-tick loser refuse new side effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPollDeadline, POLL_EXPIRED, monotonicNowMs, type PollDeadlineToken } from '../../src/browser/web-ai/poll-deadline.ts';

test('withPollDeadline answers with onExpired when the probe never settles', async () => {
    const t0 = monotonicNowMs();
    let sawToken: PollDeadlineToken | null = null;
    const result = await withPollDeadline<string>(
        async (_deadline, token) => {
            sawToken = token;
            await new Promise<never>(() => { /* never settles */ });
            return 'unreachable';
        },
        { timeoutMs: 500, onExpired: () => 'expired' },
    );
    const elapsed = monotonicNowMs() - t0;
    assert.equal(result, 'expired');
    // budget + one check interval + slack
    assert.ok(elapsed < 500 + 250 + 1000, `took ${elapsed}ms`);
    assert.ok(sawToken, 'runFn received a token');
    assert.equal(sawToken!.expired, true, 'token.expired flips once the caller is answered');
});

test('withPollDeadline returns the result when the run wins', async () => {
    const result = await withPollDeadline<string>(
        async () => 'ok',
        { timeoutMs: 5_000, onExpired: () => 'expired' },
    );
    assert.equal(result, 'ok');
});

test('a result settling after the deadline is normalised to expiry', async () => {
    const result = await withPollDeadline<string>(
        async (hardDeadline) => {
            await new Promise(r => setTimeout(r, (hardDeadline - Date.now()) + 400));
            return 'late';
        },
        { timeoutMs: 300, onExpired: () => 'expired' },
    );
    assert.equal(result, 'expired');
});

test('errors inside the budget propagate; POLL_EXPIRED rejection maps to onExpired', async () => {
    await assert.rejects(
        withPollDeadline<string>(async () => { throw new Error('real failure'); }, { timeoutMs: 5_000, onExpired: () => 'expired' }),
        /real failure/,
    );
    const mapped = await withPollDeadline<string>(
        async () => { throw POLL_EXPIRED; },
        { timeoutMs: 5_000, onExpired: () => 'expired' },
    );
    assert.equal(mapped, 'expired');
});

test('tighten only shortens the bound and re-arms the timer', async () => {
    const t0 = monotonicNowMs();
    const result = await withPollDeadline<string>(
        async (_deadline, token) => {
            token.tighten?.(Date.now() + 60_000); // extension attempt — ignored
            token.tighten?.(Date.now() + 300);    // real tighten
            await new Promise<never>(() => { /* never settles */ });
            return 'unreachable';
        },
        { timeoutMs: 30_000, onExpired: () => 'expired' },
    );
    const elapsed = monotonicNowMs() - t0;
    assert.equal(result, 'expired');
    assert.ok(elapsed < 5_000, `tightened run answered in ${elapsed}ms, not the original 30s`);
});

test('startedAt anchors the budget so pre-call blocking time is charged', async () => {
    const result = await withPollDeadline<string>(
        async () => {
            await new Promise(r => setTimeout(r, 250));
            return 'ok';
        },
        { startedAt: Date.now() - 10_000, timeoutMs: 10_100, onExpired: () => 'expired' },
    );
    // 10s of the 10.1s budget already spent before the call; a 250ms run overruns.
    assert.equal(result, 'expired');
});

