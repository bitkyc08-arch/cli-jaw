// Outbound turn lifecycle (#417, L1).
//
// QueueNoticeRegistry bounds the NOTICE cleanup only, and only for turns that were
// queued. The answer body, the retry sleep and the upload have no owner at all —
// shutdown does not know they exist. This is the registry that owns them, for
// every path (normal, queued, forwarder) on every channel.
//
// The contract under test is deliberately narrow: hand out a signal, compose a
// total deadline onto it, and classify why an abort happened. The per-channel
// wiring is proven in its own layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OutboundLifecycleRegistry,
    classifyAbort,
    isShutdownAbort,
    SHUTDOWN_ABORT_REASON,
    outboxOutcomeForAbort,
} from '../../src/messaging/outbound-lifecycle.ts';

test('a registered turn receives a signal that is live until it completes', () => {
    const registry = new OutboundLifecycleRegistry();
    const turn = registry.begin({ channel: 'slack', path: 'normal' });

    assert.equal(turn.signal.aborted, false);
    turn.end();
    // Ending is not aborting: the work finished on its own terms.
    assert.equal(turn.signal.aborted, false);
    assert.equal(registry.size, 0);
});

test('drain aborts every turn still running', async () => {
    const registry = new OutboundLifecycleRegistry();
    const a = registry.begin({ channel: 'slack', path: 'normal' });
    const b = registry.begin({ channel: 'telegram', path: 'queued' });

    await registry.drain(0);

    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
    assert.equal(registry.size, 0, 'a drained registry does not hold turns for a second drain');
});

test('a turn that ended before drain is not aborted by it', async () => {
    const registry = new OutboundLifecycleRegistry();
    const done = registry.begin({ channel: 'slack', path: 'normal' });
    done.end();
    const live = registry.begin({ channel: 'slack', path: 'forwarder' });

    await registry.drain(0);

    assert.equal(done.signal.aborted, false, 'ending must actually release the turn');
    assert.equal(live.signal.aborted, true);
});

test('end is idempotent so a turn with several exit paths cannot double-release', () => {
    const registry = new OutboundLifecycleRegistry();
    const turn = registry.begin({ channel: 'discord', path: 'queued' });
    turn.end();
    turn.end();
    assert.equal(registry.size, 0);
});

test('drain waits for in-flight work, bounded by its deadline', async () => {
    const registry = new OutboundLifecycleRegistry();
    const turn = registry.begin({ channel: 'slack', path: 'normal' });
    let released = false;
    // A send that never returns on its own — exactly the shape shutdown must bound.
    turn.track(new Promise<void>((resolve) => {
        turn.signal.addEventListener('abort', () => { released = true; resolve(); }, { once: true });
    }));

    await registry.drain(10);

    assert.equal(released, true, 'the deadline must abort, not merely stop waiting');
});

test('drain returns once tracked work settles, without burning the whole deadline', async () => {
    const registry = new OutboundLifecycleRegistry();
    const turn = registry.begin({ channel: 'slack', path: 'normal' });
    turn.track(Promise.resolve());

    const started = Date.now();
    await registry.drain(5_000);
    assert.ok(Date.now() - started < 4_000, 'a settled turn must not hold shutdown to its deadline');
});

test('a total deadline aborts the turn even while nobody is draining', async () => {
    const registry = new OutboundLifecycleRegistry();
    const turn = registry.begin({ channel: 'slack', path: 'normal', totalDeadlineMs: 5 });

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(turn.signal.aborted, true,
        'a per-call timeout cannot express "this whole turn stopped mattering"');
});

test('shutdown and vendor aborts are distinguishable', () => {
    const registry = new OutboundLifecycleRegistry();
    const turn = registry.begin({ channel: 'slack', path: 'normal' });
    turn.abort(SHUTDOWN_ABORT_REASON);

    assert.equal(isShutdownAbort(turn.signal.reason), true);
    assert.equal(classifyAbort(turn.signal.reason), 'shutdown');
    // A vendor error is not a cancellation, and treating it as one would hide it.
    assert.equal(classifyAbort(new Error('slack ratelimited')), 'vendor');
});

test('a drained turn reports shutdown, not a vendor failure', async () => {
    const registry = new OutboundLifecycleRegistry();
    const turn = registry.begin({ channel: 'telegram', path: 'queued' });
    await registry.drain(0);
    assert.equal(classifyAbort(turn.signal.reason), 'shutdown');
});

test('a turn begun after drain is live, so a re-init is not born cancelled', async () => {
    const registry = new OutboundLifecycleRegistry();
    registry.begin({ channel: 'slack', path: 'normal' });
    await registry.drain(0);

    const next = registry.begin({ channel: 'slack', path: 'normal' });
    assert.equal(next.signal.aborted, false);
});

test('a caller signal composes with the turn signal', async () => {
    const registry = new OutboundLifecycleRegistry();
    const caller = new AbortController();
    const turn = registry.begin({ channel: 'slack', path: 'normal', signal: caller.signal });

    caller.abort(new Error('user cancelled'));

    assert.equal(turn.signal.aborted, true, 'an upstream cancel must reach the vendor call');
    assert.equal(classifyAbort(turn.signal.reason), 'vendor');
});

// ─── outbound_attempts接点 ───────────────────────────

test('a send aborted after dispatch is ambiguous, not a definitive failure', () => {
    // The row is already 'sending', so the bytes may well have reached the vendor.
    // Calling it definitive would let a replay send the message twice.
    assert.equal(
        outboxOutcomeForAbort({ state: 'sending', reason: SHUTDOWN_ABORT_REASON }),
        'ambiguous',
    );
});

test('a send aborted before dispatch is definitively failed', () => {
    // Nothing left the process, so nobody could have seen it.
    assert.equal(
        outboxOutcomeForAbort({ state: 'pending', reason: SHUTDOWN_ABORT_REASON }),
        'definitive_failed',
    );
});

test('a vendor abort mid-flight is still ambiguous', () => {
    // "The socket died" says nothing about whether the request was processed.
    assert.equal(
        outboxOutcomeForAbort({ state: 'sending', reason: new Error('ECONNRESET') }),
        'ambiguous',
    );
});

test('a terminal row is never re-marked by a late abort', () => {
    // The turn was cancelled after the send already landed. Rewriting that to
    // ambiguous would manufacture doubt about a delivery we confirmed.
    for (const state of ['sent', 'definitive_failed', 'ambiguous'] as const) {
        assert.equal(
            outboxOutcomeForAbort({ state, reason: SHUTDOWN_ABORT_REASON }), null,
            `${state} is terminal`,
        );
    }
});
