import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import { registerSendTransport, sendChannelOutput } from '../../src/messaging/send.ts';
import { clearTargetState, setLastActiveTarget } from '../../src/messaging/runtime.ts';
import { buildRemoteBindingKey } from '../../src/messaging/session-key.ts';
import { resolveOrCreateRemoteSession } from '../../src/core/chat-sessions.ts';
import { db } from '../../src/core/db.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

// #397: a file built for channel A was uploaded to channel B. The agent's send went
// through /api/channel/send, and with no explicit target that resolves to a single
// per-channel last-active slot which every inbound message overwrites.
//
// Addressing the channel explicitly was the correct move and it 403'd: with no
// configured allowlist the only conversations authorizeExplicitTarget would vouch
// for were those same volatile slots. The safe path was refused and the unsafe one
// accepted. These tests pin that an explicitly addressed, bound conversation is
// authorized even while the slot points somewhere else.

const working: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'channel',
    targetId: 'C_WORKING', threadId: '1787194176.603639',
};
const noisy: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'channel',
    targetId: 'C_NOISY', threadId: '1787205619.581069',
};

function withSlack(channelIds: string[], fn: () => Promise<void>) {
    const prevSlack = settings['slack'];
    const prevMessaging = settings['messaging'];
    settings['slack'] = { ...(prevSlack || {}), channelIds };
    settings['messaging'] = { enabledChannels: ['slack'], homeChannel: 'slack' };
    return fn().finally(() => {
        settings['slack'] = prevSlack;
        settings['messaging'] = prevMessaging;
        clearTargetState();
    });
}

test('CST-001: an explicitly addressed bound conversation wins over the last-active slot', async () => {
    // The bot has been addressed in the working channel, so it is bound.
    resolveOrCreateRemoteSession(buildRemoteBindingKey(working));
    // Meanwhile a different channel spoke most recently and owns the slot.
    const sent: Array<Record<string, any>> = [];
    registerSendTransport('slack', async req => { sent.push(structuredClone(req)); return { ok: true }; });

    await withSlack([], async () => {
        setLastActiveTarget('slack', noisy);

        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'for the working channel', target: working });

        assert.equal(result.ok, true, 'addressing the conversation explicitly must not 403');
        assert.equal(sent.at(-1)?.target?.targetId, 'C_WORKING');
        assert.equal(sent.at(-1)?.target?.threadId, working.threadId);
    });

    db.prepare('DELETE FROM remote_session_bindings WHERE remote_key = ?')
        .run(buildRemoteBindingKey(working));
});

test('CST-002: an unbound conversation the bot never spoke in is still refused', async () => {
    registerSendTransport('slack', async () => ({ ok: true }));

    await withSlack([], async () => {
        setLastActiveTarget('slack', noisy);

        const stranger: RemoteTarget = {
            channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_STRANGER',
        };
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'nope', target: stranger });

        assert.equal(result.ok, false, 'binding is the evidence; without it there is none');
        assert.equal(result.status, 403);
    });
});

test('CST-003: a configured allowlist still governs', async () => {
    resolveOrCreateRemoteSession(buildRemoteBindingKey(working));
    registerSendTransport('slack', async () => ({ ok: true }));

    await withSlack(['C_SOMETHING_ELSE'], async () => {
        const result = await sendChannelOutput({ channel: 'slack', type: 'text', text: 'nope', target: working });

        assert.equal(result.ok, false, 'a binding must not widen a configured allowlist');
        assert.equal(result.status, 403);
    });

    db.prepare('DELETE FROM remote_session_bindings WHERE remote_key = ?')
        .run(buildRemoteBindingKey(working));
});

