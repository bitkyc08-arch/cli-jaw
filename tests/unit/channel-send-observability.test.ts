// Whether an outbound send is OBSERVABLE, and observable ENOUGH.
//
// This is not tidiness. Auditing 'did one turn answer twice' against logs is
// only sound if every send path appears in them AND the record says where the
// send went and what kind it was. Only the inbound bot modules write a human
// `[slack:out]` line, so heartbeat reports, mention-watch answers, agent
// /api/channel/send tool calls, and forwarder relays are invisible to a
// text-log census — exactly the paths most likely to double. And a bare
// {channel, result} event cannot separate a turn's final answer from a progress
// edit, which makes a duplicate indistinguishable from ordinary traffic.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSendTransport, sendChannelOutput } from '../../src/messaging/send.ts';
import { settings } from '../../src/core/config.ts';
import { log } from '../../src/core/logger.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const target: RemoteTarget = {
    channel: 'slack',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId: 'C_OBSERVABILITY',
};

type Captured = { name: string; payload: Record<string, unknown> };

function captureEvents(): { events: Captured[]; restore: () => void } {
    const events: Captured[] = [];
    const original = log.event;
    log.event = ((name: string, payload: Record<string, unknown>) => {
        events.push({ name, payload });
    }) as typeof log.event;
    return { events, restore: () => { log.event = original; } };
}

function allow(): void {
    settings['slack'] = { ...(settings['slack'] || {}), channelIds: [target.targetId] };
}

const sends = (events: Captured[]) => events.filter(e => e.name === 'outbound.send');

test('a successful send records its destination and kind, not just the channel', async () => {
    allow();
    registerSendTransport('slack', async () => ({ ok: true }));
    const cap = captureEvents();
    try {
        const result = await sendChannelOutput({ channel: 'slack', target, type: 'text', text: 'hello' });
        assert.equal(result.ok, true);
        const recorded = sends(cap.events);
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0]?.payload['result'], 'ok');
        // Without these two a census cannot attribute a send to a conversation
        // or tell a final answer from a progress edit.
        assert.equal(recorded[0]?.payload['target'], target.targetId);
        assert.equal(recorded[0]?.payload['type'], 'text');
    } finally { cap.restore(); }
});

test('an agent-surface send is marked, so it is distinguishable from a server post', async () => {
    allow();
    registerSendTransport('slack', async () => ({ ok: true }));
    const cap = captureEvents();
    try {
        await sendChannelOutput({ channel: 'slack', target, type: 'text', text: 'hi', fromAgentSurface: true });
        assert.equal(sends(cap.events)[0]?.payload['via'], 'agent');
    } finally { cap.restore(); }
});

test('a server-side send carries no agent marker', async () => {
    allow();
    registerSendTransport('slack', async () => ({ ok: true }));
    const cap = captureEvents();
    try {
        await sendChannelOutput({ channel: 'slack', target, type: 'text', text: 'hi' });
        assert.equal(sends(cap.events)[0]?.payload['via'], undefined);
    } finally { cap.restore(); }
});

test('a failed send is recorded as an error, not as a delivery', async () => {
    allow();
    registerSendTransport('slack', async () => ({ ok: false, error: 'nope' }));
    const cap = captureEvents();
    try {
        const result = await sendChannelOutput({ channel: 'slack', target, type: 'text', text: 'hello' });
        assert.equal(result.ok, false);
        assert.equal(sends(cap.events)[0]?.payload['result'], 'error');
    } finally { cap.restore(); }
});

test('the record carries no message body', async () => {
    // The body is redacted elsewhere at real cost; a duplicate audit needs the
    // surface and destination, not the words.
    allow();
    registerSendTransport('slack', async () => ({ ok: true }));
    const cap = captureEvents();
    try {
        await sendChannelOutput({ channel: 'slack', target, type: 'text', text: 'SENSITIVE_BODY_TEXT' });
        const serialized = JSON.stringify(sends(cap.events)[0]?.payload ?? {});
        assert.doesNotMatch(serialized, /SENSITIVE_BODY_TEXT/);
    } finally { cap.restore(); }
});

test('a file send reports its own kind, so it is not counted as a written answer', async () => {
    // A photo/document send and a text answer are both outbound.send. Counting
    // them together would read an image plus its written answer as a duplicate.
    allow();
    registerSendTransport('slack', async () => ({ ok: true }));
    const cap = captureEvents();
    try {
        await sendChannelOutput({ channel: 'slack', target, type: 'photo', filePath: '/tmp/x.png', caption: 'cap' });
        assert.equal(sends(cap.events)[0]?.payload['type'], 'photo');
    } finally { cap.restore(); }
});

