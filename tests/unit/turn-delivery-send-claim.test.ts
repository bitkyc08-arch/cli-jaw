import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSendTransport, sendChannelOutput } from '../../src/messaging/send.ts';
import { settings } from '../../src/core/config.ts';
import {
    resetTurnDeliveryState,
    wasSelfDelivered,
    nextDeliverySeq,
} from '../../src/messaging/turn-delivery.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

// What sendChannelOutput records is the contract this whole mechanism rests on.
// A claim for something the transport did not actually put on screen cancels a
// real answer, so these cases are about SILENCE, not tidiness.

const target: RemoteTarget = {
    channel: 'slack',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId: 'C_CLAIM_TEST',
};

function stubSlackTransport(): void {
    registerSendTransport('slack', async () => ({ ok: true }));
}

/** The target must pass the same allowlist a real send faces, or the request is
 *  refused before it can claim anything and the test proves nothing. */
function allowTarget(): void {
    settings['slack'] = { ...(settings['slack'] || {}), channelIds: [target.targetId] };
}

test('WP2-SEND-001: a file send promotes its text into the caption and claims it (#517)', async () => {
    resetTurnDeliveryState();
    stubSlackTransport();
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    // The agent uploads a chart and passes its written answer in `text`. This
    // used to be dropped on the floor: the file handlers read `caption` and
    // nothing else, so the user got a bare upload under no explanation — 33% of
    // one bot's posts were empty messages with a file attached (#517).
    const answer = 'the full written answer the user is waiting for';
    const sent: Record<string, unknown>[] = [];
    registerSendTransport('slack', async (req) => { sent.push(req as Record<string, unknown>); return { ok: true }; });

    await sendChannelOutput({
        channel: 'slack',
        type: 'photo',
        filePath: '/tmp/never-read-by-this-test.png',
        text: answer,
        target,
        fromAgentSurface: true,
    });

    assert.equal(sent[0]?.['caption'], answer, 'the answer must reach the field the transport displays');
    assert.equal(
        wasSelfDelivered({ target, text: answer, since: turnStartedAt }),
        true,
        'now that the text is on screen, the claim is honest and the dispatch post must not repeat it',
    );
});

test('WP2-SEND-001b: an explicit caption still wins, and the unsent text is not claimed', async () => {
    resetTurnDeliveryState();
    stubSlackTransport();
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    // The invariant the original test protected, on the input where it still
    // applies: when the caller chose a caption, THAT is what ships, and claiming
    // the unshipped `text` would let an invisible string cancel the real answer.
    await sendChannelOutput({
        channel: 'slack',
        type: 'photo',
        filePath: '/tmp/never-read-by-this-test.png',
        text: 'the full written answer the user is waiting for',
        caption: 'chart',
        target,
        fromAgentSurface: true,
    });

    assert.equal(
        wasSelfDelivered({
            target,
            text: 'the full written answer the user is waiting for',
            since: turnStartedAt,
        }),
        false,
        'text that lost to an explicit caption never reached the user, so it cannot be claimed',
    );
});

test('a file send claims its caption, which the transport does deliver', async () => {
    resetTurnDeliveryState();
    stubSlackTransport();
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    await sendChannelOutput({
        channel: 'slack',
        type: 'photo',
        filePath: '/tmp/never-read-by-this-test.png',
        caption: 'here is the chart',
        target,
        fromAgentSurface: true,
    });

    assert.equal(
        wasSelfDelivered({ target, text: 'here is the chart', since: turnStartedAt }),
        true,
    );
});

test('a plain text send claims its text', async () => {
    resetTurnDeliveryState();
    stubSlackTransport();
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    await sendChannelOutput({
        channel: 'slack', type: 'text', text: 'the answer', target, fromAgentSurface: true,
    });

    assert.equal(wasSelfDelivered({ target, text: 'the answer', since: turnStartedAt }), true);
});

test('a send from an internal caller is never claimed', async () => {
    resetTurnDeliveryState();
    stubSlackTransport();
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    // Heartbeats, reminders, alert escalation and the target-reply forwarders all
    // share this function. If their sends were claimed, a background message
    // could cancel a real answer.
    await sendChannelOutput({
        channel: 'slack', type: 'text', text: 'scheduled report', target,
    });

    assert.equal(
        wasSelfDelivered({ target, text: 'scheduled report', since: turnStartedAt }),
        false,
    );
});

test('a failed send is not claimed', async () => {
    resetTurnDeliveryState();
    registerSendTransport('slack', async () => ({ ok: false, error: 'channel_not_found' }));
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    await sendChannelOutput({
        channel: 'slack', type: 'text', text: 'never arrived', target, fromAgentSurface: true,
    });

    assert.equal(
        wasSelfDelivered({ target, text: 'never arrived', since: turnStartedAt }),
        false,
        'nothing reached the user, so nothing may be suppressed',
    );
});

