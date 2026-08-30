// The shared Slack transport must record its own posts.
//
// `sendChannelOutput` is not the path most Slack answers take: the dispatch
// settle path, the queued reply, the recovered-queue forwarder, and the generic
// forwarder all call `sendSlackText` directly. Instrumenting only the choke point
// left exactly those invisible — the set a 'did one turn answer twice' audit
// needs — so a census over the other record could look complete while missing
// them. That is the mistake devlog 050 documents.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { sendSlackText } from '../../src/slack/send-only-client.ts';
import { log } from '../../src/core/logger.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const target: RemoteTarget = {
    channel: 'slack',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId: 'C_TRANSPORT',
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

/** Slack answering every chat.postMessage with a ts. */
function okFetch(): typeof fetch {
    let n = 0;
    return (async () => new Response(
        JSON.stringify({ ok: true, ts: `170000000.0001${n++}` }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

const posts = (events: Captured[]) => events.filter(e => e.name === 'slack.post');

test('a direct transport send is recorded, not only choke-point sends', async () => {
    const cap = captureEvents();
    try {
        const result = await sendSlackText('xoxb-t', target, 'hello', { fetchImpl: okFetch() });
        assert.equal(result.ok, true);
        const recorded = posts(cap.events);
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0]?.payload['target'], target.targetId);
        assert.equal(recorded[0]?.payload['result'], 'ok');
    } finally { cap.restore(); }
});

test('a thread reply is marked, so channel and thread posts are distinguishable', async () => {
    const cap = captureEvents();
    try {
        await sendSlackText('xoxb-t', { ...target, threadId: '170000000.000100' }, 'hi', { fetchImpl: okFetch() });
        assert.equal(posts(cap.events)[0]?.payload['threaded'], true);
    } finally { cap.restore(); }
});

test('a channel post carries no thread marker', async () => {
    const cap = captureEvents();
    try {
        await sendSlackText('xoxb-t', target, 'hi', { fetchImpl: okFetch() });
        assert.equal(posts(cap.events)[0]?.payload['threaded'], undefined);
    } finally { cap.restore(); }
});

test('a chunked answer is ONE recorded send carrying its chunk count', async () => {
    // One logical answer over the Slack length limit becomes several posts.
    // Counting posts rather than sends would read a long answer as a duplicate.
    const cap = captureEvents();
    try {
        await sendSlackText('xoxb-t', target, 'x'.repeat(9000), { fetchImpl: okFetch() });
        const recorded = posts(cap.events);
        assert.equal(recorded.length, 1);
        assert.ok((recorded[0]?.payload['chunks'] as number) > 1);
    } finally { cap.restore(); }
});

test('a failed send is not recorded as a post', async () => {
    const cap = captureEvents();
    const failing = (async () => new Response(
        JSON.stringify({ ok: false, error: 'channel_not_found' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    try {
        const result = await sendSlackText('xoxb-t', target, 'hi', { fetchImpl: failing });
        assert.equal(result.ok, false);
        assert.equal(posts(cap.events).length, 0);
    } finally { cap.restore(); }
});

test('the record carries no message body', async () => {
    const cap = captureEvents();
    try {
        await sendSlackText('xoxb-t', target, 'SENSITIVE_TRANSPORT_BODY', { fetchImpl: okFetch() });
        assert.doesNotMatch(JSON.stringify(posts(cap.events)[0]?.payload ?? {}), /SENSITIVE_TRANSPORT_BODY/);
    } finally { cap.restore(); }
});
