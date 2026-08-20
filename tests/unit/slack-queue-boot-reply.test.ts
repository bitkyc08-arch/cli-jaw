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
        target: slackTarget('C_BOOT', '1710000000.000100'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(sent.length, 1, `the reply must be delivered; saw ${JSON.stringify(sent)}`);
    assert.equal(sent[0]!.targetId, 'C_BOOT', 'it must go to the conversation the item carried');
    assert.equal(sent[0]!.threadId, '1710000000.000100', 'and into the thread it came from');
});

test('SQB-002: a result addressed to another channel is not answered here', async () => {
    sent.length = 0;
    const { broadcast } = await import('../../src/core/bus.ts');

    broadcast('orchestrate_done', {
        text: 'telegram answer', origin: 'telegram', requestId: 'req-tg',
        target: { channel: 'telegram', targetKind: 'user', peerKind: 'direct', targetId: '123' },
    });
    // No target at all: nowhere to send, and the last-active fallback belongs to
    // the ordinary forwarder, not to this one.
    broadcast('orchestrate_done', { text: 'targetless', origin: 'slack', requestId: 'req-none' });
    // An error result already reaches the user through its own path.
    broadcast('orchestrate_done', {
        text: '[error] boom', error: true, origin: 'slack', requestId: 'req-err',
        target: slackTarget('C_BOOT'),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(sent, [], `nothing may be sent; saw ${JSON.stringify(sent)}`);
});
