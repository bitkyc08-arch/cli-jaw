// The one-time thread prefetch claim.
//
// This is the state that decides whether an agent pulled into a thread mid-way
// gets to see what was said before it arrived. Getting it wrong is quiet in both
// directions: claim too eagerly and the history is never injected, release
// carelessly and it is injected twice.
//
// Participation tracking cannot answer this question — app_mention marks a
// thread BEFORE the ingress task runs, so a participation check inside that task
// is a dead branch (#316).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    claimThreadPrefetch,
    releaseThreadPrefetch,
    resetThreadPrefetchClaims,
} from '../../src/slack/thread-tracker.ts';
import { buildThreadPreamble, PREAMBLE_TOTAL_CAP } from '../../src/slack/context.ts';

test.beforeEach(() => resetThreadPrefetchClaims());

test('a thread is claimable exactly once', () => {
    const first = claimThreadPrefetch('C1', '100.1');
    const second = claimThreadPrefetch('C1', '100.1');
    assert.ok(first > 0, 'the first caller wins');
    assert.equal(second, 0, 'the second is refused');
});

test('different threads and channels claim independently', () => {
    assert.ok(claimThreadPrefetch('C1', '100.1') > 0);
    assert.ok(claimThreadPrefetch('C1', '200.2') > 0, 'another thread is unaffected');
    assert.ok(claimThreadPrefetch('C2', '100.1') > 0, 'the key is channel-scoped');
});

test('a released claim can be taken again', () => {
    const token = claimThreadPrefetch('C1', '100.1');
    releaseThreadPrefetch('C1', '100.1', token);
    assert.ok(claimThreadPrefetch('C1', '100.1') > 0, 'a failed attempt must not be permanent');
});

test('a stale token cannot release the current owner (ABA)', () => {
    // A claims, times out and releases; B claims; A's straggler tries to release.
    const a = claimThreadPrefetch('C1', '100.1');
    releaseThreadPrefetch('C1', '100.1', a);
    const b = claimThreadPrefetch('C1', '100.1');
    assert.ok(b > 0);

    releaseThreadPrefetch('C1', '100.1', a);   // the straggler
    assert.equal(
        claimThreadPrefetch('C1', '100.1'), 0,
        "a late release from an abandoned attempt must not free someone else's claim",
    );
    // And B can still release its own.
    releaseThreadPrefetch('C1', '100.1', b);
    assert.ok(claimThreadPrefetch('C1', '100.1') > 0);
});

test('releasing with no token is a no-op', () => {
    claimThreadPrefetch('C1', '100.1');
    releaseThreadPrefetch('C1', '100.1', 0);
    assert.equal(claimThreadPrefetch('C1', '100.1'), 0, 'the claim still stands');
});

test('an empty channel or thread never claims', () => {
    assert.equal(claimThreadPrefetch('', '100.1'), 0);
    assert.equal(claimThreadPrefetch('C1', ''), 0);
});

test('reset clears every claim', () => {
    claimThreadPrefetch('C1', '100.1');
    resetThreadPrefetchClaims();
    assert.ok(claimThreadPrefetch('C1', '100.1') > 0, 'a new runtime re-injects history');
});

// ─── preamble rendering ─────────────────────────────

test('the preamble is delimited and labelled with the reply count', () => {
    const out = buildThreadPreamble('[10:00] a: hi', 3);
    assert.ok(out.startsWith('[앞선 대화 3개]'));
    assert.ok(out.endsWith('[/앞선 대화]'));
    assert.ok(out.includes('hi'));
});

test('empty history renders nothing rather than an empty frame', () => {
    assert.equal(buildThreadPreamble('   ', 3), '');
});

test('the TOTAL preamble stays within its cap, delimiters included', () => {
    // 50 messages is the fetch limit; each can be long.
    const rendered = Array.from({ length: 50 },
        (_, i) => `[10:00] user${i}: ${'가'.repeat(500)}`).join('\n');
    const out = buildThreadPreamble(rendered, 50);
    assert.ok(
        [...out].length <= PREAMBLE_TOTAL_CAP,
        `preamble was ${[...out].length} code points, cap is ${PREAMBLE_TOTAL_CAP}`,
    );
    assert.ok(out.endsWith('[/앞선 대화]'), 'the closing delimiter must survive the cap');
});
