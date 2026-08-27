import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSendTransport, sendChannelOutput } from '../../src/messaging/send.ts';
import { settings } from '../../src/core/config.ts';
import {
    resetTurnDeliveryState,
    wasSelfDelivered,
    selfDeliveredFiles,
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

test('a file send does not claim text the transport never delivered', async () => {
    resetTurnDeliveryState();
    stubSlackTransport();
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    // The agent uploads a chart and passes its written answer in `text`. The
    // Slack/Telegram/Discord file handlers all ignore `text` and send only
    // `caption` — so nothing of this string reached the user.
    await sendChannelOutput({
        channel: 'slack',
        type: 'photo',
        filePath: '/tmp/never-read-by-this-test.png',
        text: 'the full written answer the user is waiting for',
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
        'an uncaptioned file must never suppress the written answer',
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

test('an unreadable claimed file fails open rather than skipping the relay', async () => {
    resetTurnDeliveryState();
    stubSlackTransport();
    allowTarget();
    const turnStartedAt = nextDeliverySeq();

    await sendChannelOutput({
        channel: 'slack',
        type: 'document',
        filePath: '/tmp/jaw-claim-does-not-exist-9e7f.bin',
        caption: 'attached',
        target,
        fromAgentSurface: true,
    });

    // The path cannot be stat'd, so its identity is unknown; the relay must send.
    assert.equal(selfDeliveredFiles({ target, since: turnStartedAt }).size, 0);
});
