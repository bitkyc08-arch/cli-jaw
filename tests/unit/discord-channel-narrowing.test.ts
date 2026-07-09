import test from 'node:test';
import assert from 'node:assert/strict';
import { asChannelWith, asSendable, asThreadLike, asTypingChannel } from '../../src/discord/channel-types.js';

test('asSendable narrows channels with send()', async () => {
    const sent: unknown[] = [];
    const channel = { send: async (payload: unknown) => sent.push(payload) };

    const sendable = asSendable(channel);

    assert.ok(sendable);
    await sendable.send('hello');
    assert.deepEqual(sent, ['hello']);
    assert.equal(asSendable({ send: 'nope' }), null);
    assert.equal(asSendable(null), null);
});

test('asTypingChannel and asThreadLike expose optional Discord channel facets', async () => {
    let typed = false;
    const channel = {
        parentId: 'parent-1',
        sendTyping: async () => {
            typed = true;
        },
    };

    assert.equal(asThreadLike(channel)?.parentId, 'parent-1');
    await asTypingChannel(channel)?.sendTyping?.();
    assert.equal(typed, true);
    assert.equal(asTypingChannel({ sendTyping: 'nope' }), null);
});

test('asChannelWith performs structural key checks', () => {
    assert.deepEqual(asChannelWith({ send: async () => undefined }, 'send') !== null, true);
    assert.equal(asChannelWith({}, 'send'), null);
});
