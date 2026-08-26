import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import { registerSendTransport, sendChannelOutput, normalizeChannelSendRequest } from '../../src/messaging/send.ts';
import { clearTargetState, setLastActiveTarget, setLatestSeenTarget } from '../../src/messaging/runtime.ts';
import { encodeTurnConversation, turnConversationForChannel } from '../../src/messaging/turn-conversation.ts';
import { prependRemoteConversationContext } from '../../src/prompt/conversation-context.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

// #474: a user asked the bot in a DM and the answer was posted to a PUBLIC channel.
// With multi-session on, a DM turn and a channel turn run concurrently; the channel
// spoke while the DM's agent was still working, overwriting the single per-channel
// last-active slot. The DM's send carried no target — the agent had dropped it after
// an earlier refusal — so it resolved to that slot and went to the channel.
//
// These tests pin that the turn's OWN conversation wins over the volatile slots, and
// that the address is carried PER TURN so a pooled, reused agent process cannot answer
// with the address of the turn that first started it.

const dm: RemoteTarget = {
    channel: 'slack', targetKind: 'user', peerKind: 'direct', targetId: 'D0BSG315ERG',
};
const publicChannel: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'channel',
    targetId: 'C0BSJ28E8JD', threadId: '1787637906.918659',
};

function withSlack(fn: () => Promise<void>) {
    const prevSlack = settings['slack'];
    const prevMessaging = settings['messaging'];
    settings['slack'] = { ...(prevSlack || {}), channelIds: [] };
    settings['messaging'] = { enabledChannels: ['slack'], homeChannel: 'slack' };
    return fn().finally(() => {
        settings['slack'] = prevSlack;
        settings['messaging'] = prevMessaging;
        clearTargetState();
    });
}

test('TCR-001: a DM turn answers the DM even when a public channel owns the last-active slot', async () => {
    const sent: Array<Record<string, any>> = [];
    registerSendTransport('slack', async req => { sent.push(structuredClone(req)); return { ok: true }; });

    await withSlack(async () => {
        // The public channel spoke while the DM turn was still working.
        setLastActiveTarget('slack', publicChannel);
        setLatestSeenTarget('slack', publicChannel);

        // The DM turn's agent echoes the address from its own turn prompt.
        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'DM answer', turnTarget: dm,
        });

        assert.equal(result.ok, true);
        assert.equal(sent.at(-1)?.target?.targetId, dm.targetId, 'the DM turn must answer in the DM');
    });
});

test('TCR-002: an explicit target still outranks the turn address', async () => {
    const sent: Array<Record<string, any>> = [];
    registerSendTransport('slack', async req => { sent.push(structuredClone(req)); return { ok: true }; });

    await withSlack(async () => {
        const other: RemoteTarget = {
            channel: 'slack', targetKind: 'user', peerKind: 'direct', targetId: 'D0BPD8A25K4',
        };
        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'addressed', target: other, turnTarget: dm,
        });

        assert.equal(result.ok, true);
        assert.equal(sent.at(-1)?.target?.targetId, other.targetId);
    });
});

test('TCR-003: a scheduled sender opting out of the active chain is unaffected', async () => {
    registerSendTransport('slack', async () => ({ ok: true }));

    await withSlack(async () => {
        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'scheduled', allowActiveFallback: false, turnTarget: dm,
        });

        assert.equal(result.ok, false, 'allowActiveFallback:false must still fail closed');
    });
});

test('TCR-004: the echoed address is channel-matched', () => {
    assert.equal(turnConversationForChannel(dm, 'telegram'), null, 'a Slack turn must not address Telegram');
    assert.equal(turnConversationForChannel(null, 'slack'), null);
    assert.equal(turnConversationForChannel(dm, 'slack')?.targetId, dm.targetId);
});

// The env-var version of this fix was wrong for exactly this reason: `codex-app`
// leases pooled processes and the pool sets env only at CREATION, so turn 2 on a
// reused process would echo turn 1's address. With multi-session OFF every
// conversation shares one scope, so that would have misdelivered constantly.
test('TCR-006: each turn carries its own address, so a reused process cannot reuse one', () => {
    const first = prependRemoteConversationContext('turn one', dm);
    const second = prependRemoteConversationContext('turn two', publicChannel);

    assert.ok(first.includes(`reply_to=${encodeTurnConversation(dm)}`));
    assert.ok(second.includes(`reply_to=${encodeTurnConversation(publicChannel)}`));
    assert.ok(!second.includes(dm.targetId), 'the second turn must not carry the first turn\'s address');
});

test('TCR-007: a turn address still faces the allowlist', async () => {
    registerSendTransport('slack', async () => ({ ok: true }));

    const prevSlack = settings['slack'];
    const prevMessaging = settings['messaging'];
    settings['slack'] = { ...(prevSlack || {}), channelIds: ['C_ALLOWED'] };
    settings['messaging'] = { enabledChannels: ['slack'], homeChannel: 'slack' };
    try {
        const outside: RemoteTarget = {
            channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_NOT_ALLOWED',
        };
        const result = await sendChannelOutput({
            channel: 'slack', type: 'text', text: 'nope', turnTarget: outside,
        });
        assert.notEqual(result.target?.targetId, 'C_NOT_ALLOWED', 'an echo must not widen the allowlist');
    } finally {
        settings['slack'] = prevSlack;
        settings['messaging'] = prevMessaging;
        clearTargetState();
    }
});

test('TCR-005: the HTTP normalizer keeps an echoed turn address', () => {
    const normalized = normalizeChannelSendRequest({
        channel: 'slack', type: 'text', text: 'hi',
        turn_conversation: encodeTurnConversation(dm),
    });
    assert.equal(normalized.turnTarget?.targetId, dm.targetId);

    const garbage = normalizeChannelSendRequest({ channel: 'slack', type: 'text', text: 'hi', turn_conversation: '{' });
    assert.equal(garbage.turnTarget, undefined, 'a malformed echo must not become a target');
});
