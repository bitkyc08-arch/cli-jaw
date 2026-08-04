// SL-FILE-06 through the REAL bot.ts wiring.
//
// tests/unit/slack-ingress-order.test.ts proves the SessionLanes contract with
// injected tasks. That leaves the actual question open: does bot.ts put the
// progress post INSIDE the reserved lane? If startSlackProgress() were awaited
// before admitSlackRun (the pre-phase-100 shape), the lane contract would still
// pass while real Slack traffic raced. So this suite stalls the real progress
// post and drives processSlackMessageEvent().
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

const events: string[] = [];
let progressGate: Deferred | null = null;
let collectGate: Deferred | null = null;

mock.module('../../src/slack/progress.ts', {
    namedExports: {
        startSlackProgress: async () => {
            events.push('progress:start');
            if (progressGate) await progressGate.promise;
            return { update: () => { }, finish: async () => { } };
        },
        statusFromToolEvent: () => null,
    },
});

mock.module('../../src/orchestrator/collect.ts', {
    namedExports: {
        orchestrateAndCollect: async () => {
            events.push('collect');
            if (collectGate) await collectGate.promise;
            return 'reply';
        },
    },
});

mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ token: 'xoxb-test' }),
        sendSlackText: async () => { events.push('send'); },
    },
});

mock.module('../../src/slack/forwarder.ts', {
    namedExports: {
        createSlackForwarder: () => () => { },
        relaySlackImages: async () => { },
    },
});

const { processSlackMessageEvent } = await import('../../src/slack/bot.ts');
const { resetSlackIngress } = await import('../../src/slack/ingress.ts');

const target = (id: string) => ({
    channel: 'slack' as const,
    targetKind: 'channel' as const,
    peerKind: 'channel' as const,
    targetId: id,
});

const event = (channel: string) => ({ channel, user: 'U1', ts: '1.0' }) as never;

/** Let every already-queued microtask/timer turn drain before observing. */
async function settle(turns = 5): Promise<void> {
    for (let i = 0; i < turns; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** Wait until `events` contains the expected entry, or fail loudly. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`timed out waiting for ${label}; saw ${JSON.stringify(events)}`);
}

test.beforeEach(async () => {
    // Release any gate a previous test left parked and let its lane drain, so
    // leftover work cannot land in the next test's event log. resetSlackIngress()
    // is deliberately NOT called here: it bumps the ingress generation, and these
    // tests drive processSlackMessageEvent/sessionLanes rather than ingress tasks.
    progressGate?.resolve();
    collectGate?.resolve();
    await settle(10);
    events.length = 0;
    progressGate = null;
    collectGate = null;
    settings.multiSession.enabled = true;
    settings.multiSession.channels.slack = true;
    settings.multiSession.maxConcurrent = 4;
});

// Each test uses its own channel ids so a lane parked by an earlier test can
// never serialize against the current one.

test('SL-FILE-06: a stalled progress post blocks the next same-channel run from collecting', async () => {
    progressGate = deferred();
    const controller = new AbortController();

    const first = processSlackMessageEvent(event('C1'), target('C1'), 'one', controller.signal);
    await waitFor(() => events.includes('progress:start'), 'the first progress post');
    // The first run owns the lane and is parked on the progress post.
    assert.deepEqual(events, ['progress:start']);

    const second = processSlackMessageEvent(event('C1'), target('C1'), 'two', controller.signal);
    await settle();
    // If the progress await lived outside the lane, the second run would have
    // reached its own progress post (or collect) by now.
    assert.deepEqual(events, ['progress:start'],
        'second same-scope run must not start while the first holds the lane');

    progressGate.resolve();
    await Promise.all([first, second]);
    // processSlackMessageEvent returns once admission is done; the reply itself
    // is owned by the reserved lane, so drain on the observable effect instead.
    await waitFor(() => events.filter(entry => entry === 'collect').length === 2,
        'both runs to finish collecting');

    assert.ok(events.indexOf('collect') < events.lastIndexOf('progress:start'),
        `the first run must collect before the second posts progress; saw ${JSON.stringify(events)}`);
});

test('a different channel is not blocked by a stalled run', async () => {
    progressGate = deferred();
    const controller = new AbortController();

    const first = processSlackMessageEvent(event('D1'), target('D1'), 'one', controller.signal);
    await waitFor(() => events.includes('progress:start'), 'the first progress post');

    const other = processSlackMessageEvent(event('D2'), target('D2'), 'two', controller.signal);
    await waitFor(() => events.filter(entry => entry === 'progress:start').length === 2,
        'the second scope to enter its own lane while the first is stalled');

    progressGate.resolve();
    await Promise.all([first, other]);
});

test('an aborted signal admits nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await processSlackMessageEvent(event('E1'), target('E1'), 'one', controller.signal);
    await settle();
    assert.deepEqual(events, [], 'an aborted ingress must not post progress or collect');
});
