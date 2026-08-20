import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// A boot-drained turn has no live requester. Isolated in its own file because it
// mocks the Slack send path, and a partial mock of that module would change what
// every other Slack test observes.

const sent: Array<{ targetId: string; threadId?: string; text: string }> = [];

mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ ok: true, token: 'xoxb-boot-reply' }),
        invalidateSlackSendClient: () => {},
        resolveSlackDmChannel: async () => ({ ok: true, channelId: 'D1' }),
        sendSlackText: async (
            _token: string,
            target: { targetId: string; threadId?: string },
            text: string,
        ) => {
            sent.push({ targetId: target.targetId, threadId: target.threadId, text });
            return { ok: true };
        },
    },
});

mock.module('../../src/slack/forwarder.ts', {
    namedExports: {
        createSlackForwarder: () => () => {},
        relaySlackImages: async () => {},
        chunkSlackText: (s: string) => [s],
    },
});

const slackTarget = (targetId: string, threadId?: string) => ({
    channel: 'slack' as const,
    targetKind: 'channel' as const,
    peerKind: 'channel' as const,
    targetId,
    ...(threadId ? { threadId } : {}),
});

/**
 * The ordinary queued reply rides a listener armed by the request that was
 * queued. A restart destroys it, and the boot drain (#407) runs exactly those
 * messages — so without a standing forwarder the drain consumes the item,
 * deletes its row, and the answer goes nowhere. The user does not wait longer;
 * the user never gets an answer.
 */
test('SQB-001: a queued result with no live requester still reaches its conversation', async () => {
    sent.length = 0;
    const { settings } = await import('../../src/core/config.ts');
    (settings as Record<string, unknown>)['slack'] = { enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' };
    await import('../../src/slack/bot.ts');   // installs the standing forwarder
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: 'answer for a conversation nobody is waiting in',
        origin: 'slack',
        requestId: 'req-boot-drain',
        fromQueue: true,
        target: slackTarget('C_BOOT', '1710000000.000100'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(sent.length, 1, `the reply must be delivered; saw ${JSON.stringify(sent)}`);
    assert.equal(sent[0]!.targetId, 'C_BOOT', 'it must go to the conversation the item carried');
    assert.equal(sent[0]!.threadId, '1710000000.000100', 'and into the thread it came from');
});

// The dispatch path posts an ordinary reply itself while still awaiting it. If
// the fallback fires for those too, EVERY Slack answer goes out twice — a worse
// bug than the one it fixes, and invisible to a test that only ever broadcasts
// queued events.
test('SQB-001b: an ordinary reply is not posted a second time', async () => {
    sent.length = 0;
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: 'ordinary reply, already posted by the dispatch path',
        origin: 'slack',
        requestId: 'req-ordinary',
        target: slackTarget('C_BOOT', '1710000000.000200'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(sent, [], `a non-queued completion must not be echoed; saw ${JSON.stringify(sent)}`);
});

test('SQB-002: a result addressed to another channel is not answered here', async () => {
    sent.length = 0;
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: 'telegram answer', origin: 'telegram', requestId: 'req-tg',
        fromQueue: true,
        target: { channel: 'telegram', targetKind: 'user', peerKind: 'direct', targetId: '123' },
    });
    // No target at all: nowhere to send, and the last-active fallback belongs to
    // the ordinary forwarder, not to this one.
    broadcast('orchestrate_done', { text: 'targetless', origin: 'slack', requestId: 'req-none', fromQueue: true });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(sent, [], `nothing may be sent; saw ${JSON.stringify(sent)}`);
});

// A queued turn that FAILED has the same problem as one that succeeded: after a
// restart no waiter is left to show the failure. Dropping it here does not route
// it elsewhere — it means the user's message disappears with no reply at all,
// which is the exact silence #407 is about.
test('SQB-003: a queued turn that failed still says so', async () => {
    sent.length = 0;
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: '[error] boom', error: true, origin: 'slack', requestId: 'req-err',
        fromQueue: true,
        target: slackTarget('C_BOOT'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(sent.length, 1, `a failure must still reach the user; saw ${JSON.stringify(sent)}`);
    assert.match(sent[0]!.text, /\[error\] boom/);
});

// The other half of SQB-003: while a requester IS still waiting, the failure is
// its to report. Delivering errors here was the fix for a restart, and it must
// not turn every ordinary failure into two messages.
test('SQB-003b: a failure with a live requester is reported once', async () => {
    sent.length = 0;
    const { broadcast, addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
    const bot = await import('../../src/slack/bot.ts');

    // Stand in for the dispatch path's queued-reply listener: claim the id, post
    // the result, release. This is the shape src/slack/bot.ts uses.
    const requestId = 'req-live-err';
    const posted: string[] = [];
    const waiter = (type: string, data: Record<string, unknown>) => {
        if (type !== 'orchestrate_done' || data["requestId"] !== requestId) return;
        posted.push(String(data["text"]));
    };
    addBroadcastListener(waiter);
    bot.claimSlackQueueRequestForTest(requestId);
    try {
        broadcast('orchestrate_done', {
            text: '[error] boom', error: true, origin: 'slack', requestId,
            fromQueue: true, target: slackTarget('C_BOOT'),
        });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(posted.length, 1, 'the live requester reports it');
        assert.deepEqual(sent, [], `the fallback must stay out of it; saw ${JSON.stringify(sent)}`);
    } finally {
        removeBroadcastListener(waiter);
        bot.releaseSlackQueueRequestForTest(requestId);
    }
});
