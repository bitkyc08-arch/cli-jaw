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

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settings } from '../../src/core/config.ts';

import {
    claimThreadPrefetch as claimThreadPrefetchForOwner,
    commitThreadPrefetch as commitThreadPrefetchForOwner,
    releaseThreadPrefetch as releaseThreadPrefetchForOwner,
    resetThreadPrefetchClaims,
    resetThreadTrackerForTest,
} from '../../src/slack/thread-tracker.ts';
import { buildThreadPreamble, PREAMBLE_TOTAL_CAP } from '../../src/slack/context.ts';

const OWNER = { global: 0, scope: 0 };
const claimThreadPrefetch = (channel: string, threadTs: string) =>
    claimThreadPrefetchForOwner(channel, threadTs, OWNER);
const commitThreadPrefetch = (channel: string, threadTs: string, token: number) =>
    commitThreadPrefetchForOwner(channel, threadTs, OWNER, token);
const releaseThreadPrefetch = (channel: string, threadTs: string, token: number) =>
    releaseThreadPrefetchForOwner(channel, threadTs, OWNER, token);

let recoverAttachments: () => Promise<unknown[]> = async () => [];

mock.module('../../src/slack/attachment-recovery.ts', {
    namedExports: {
        recoverSlackAttachments: async () => recoverAttachments(),
    },
});

mock.module('../../src/orchestrator/gateway.ts', {
    namedExports: {
        submitMessage: () => ({ action: 'started', requestId: 'R-prefetch' }),
    },
});

mock.module('../../src/orchestrator/collect.ts', {
    namedExports: { orchestrateAndCollect: async () => 'reply' },
});

mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ token: 'xoxb-test' }),
        sendSlackText: async () => ({ ok: true }),
    },
});

mock.module('../../src/slack/forwarder.ts', {
    namedExports: {
        createSlackForwarder: () => () => { },
        relaySlackImages: async () => { },
    },
});

const { handleSlackEnvelope } = await import('../../src/slack/bot.ts');
const { enqueueSlackIngress, resetSlackIngress } = await import('../../src/slack/ingress.ts');

const trackerPath = join(tmpdir(), `cli-jaw-prefetch-${process.pid}.json`);

test.beforeEach(async () => {
    await resetSlackIngress();
    resetThreadPrefetchClaims();
    resetThreadTrackerForTest(trackerPath);
    recoverAttachments = async () => [];
    settings.slack.channelIds = [];
    settings.slack.mentionOnly = true;
    settings.slack.threadRequireMention = false;
});

test.after(() => {
    resetThreadTrackerForTest();
    rmSync(trackerPath, { force: true });
    rmSync(`${trackerPath}.tmp`, { force: true });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function threadedEnvelope(text: string, suffix: string) {
    return {
        envelope_id: `E-${suffix}`,
        type: 'events_api',
        payload: {
            event: {
                type: 'app_mention', channel: `C-${suffix}`, user: 'U1', text,
                ts: `${suffix}.2`, thread_ts: `${suffix}.1`,
            },
        },
    } as const;
}

function assertClaimReleased(suffix: string): void {
    const token = claimThreadPrefetch(`C-${suffix}`, `${suffix}.1`);
    assert.ok(token > 0, `thread ${suffix} remained claimed`);
    releaseThreadPrefetch(`C-${suffix}`, `${suffix}.1`, token);
}

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

test('capacity pressure never evicts an active claim', () => {
    const tokens: number[] = [];
    for (let i = 0; i < 500; i += 1) {
        tokens.push(claimThreadPrefetch('C1', `${i}.1`));
    }
    assert.ok(tokens.every(token => token > 0));
    assert.equal(
        claimThreadPrefetch('C1', 'overflow.1'), 0,
        'a new prefetch must degrade while every bounded slot is active',
    );
    assert.equal(
        claimThreadPrefetch('C1', '0.1'), 0,
        'the oldest live owner must remain claimed under pressure',
    );
});

test('capacity pressure may evict completed claims but preserves active ones', () => {
    const active = claimThreadPrefetch('C1', 'active.1');
    for (let i = 0; i < 499; i += 1) {
        const ts = `done-${i}.1`;
        const token = claimThreadPrefetch('C1', ts);
        assert.ok(commitThreadPrefetch('C1', ts, token));
    }
    assert.ok(claimThreadPrefetch('C1', 'new.1') > 0, 'completed entries make bounded room');
    assert.equal(claimThreadPrefetch('C1', 'active.1'), 0, 'the live owner is never evicted');
    releaseThreadPrefetch('C1', 'active.1', active);
});

test('an accepted envelope that becomes empty releases its prefetch claim', async () => {
    // The gate accepts whitespace as a present text field, but normalization
    // below the claim turns it into an empty prompt and returns before enqueue.
    await handleSlackEnvelope(threadedEnvelope('   ', 'empty'));
    assertClaimReleased('empty');
});

test('a reset handled before enqueue releases its prefetch claim', async () => {
    await handleSlackEnvelope(threadedEnvelope('reset', 'reset'));
    assertClaimReleased('reset');
});

test('an attachment-recovery exception releases its prefetch claim', async () => {
    recoverAttachments = async () => { throw new Error('recovery failed'); };
    await assert.rejects(
        handleSlackEnvelope(threadedEnvelope('inspect attachment', 'recover-error')),
        /recovery failed/,
    );
    assertClaimReleased('recover-error');
});

test('an ingress reset that refuses handoff releases the caller-owned claim', async () => {
    const blocker = deferred<void>();
    assert.equal(
        enqueueSlackIngress('prefetch-reset-blocker', async () => blocker.promise), true,
        'the blocker must be accepted before reset starts',
    );
    await Promise.resolve();

    const recoveryEntered = deferred<void>();
    const recoveryResult = deferred<unknown[]>();
    recoverAttachments = async () => {
        recoveryEntered.resolve();
        return recoveryResult.promise;
    };

    const handling = handleSlackEnvelope(threadedEnvelope('continue', 'reset-race'));
    await recoveryEntered.promise;
    const resetting = resetSlackIngress();
    try {
        assert.equal(
            enqueueSlackIngress('prefetch-reset-probe', async () => { }), false,
            'ingress must report that it refused ownership during reset',
        );
        recoveryResult.resolve([]);
        await handling;
        assertClaimReleased('reset-race');
    } finally {
        recoveryResult.resolve([]);
        blocker.resolve();
        await resetting;
    }
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
