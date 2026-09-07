// The shared Slack transport must record its own posts.
//
// `sendChannelOutput` is not the path most Slack answers take: the dispatch
// settle path, the queued reply, the recovered-queue forwarder, and the generic
// forwarder all call `sendSlackText` directly. Instrumenting only the choke point
// left exactly those invisible — the set a 'did one turn answer twice' audit
// needs — so a census over the other record could look complete while missing
// them. Both records are required for a complete audit.
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
        assert.equal(recorded[0]?.payload['of'], 1);
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

test('a chunked answer records one post per chunk, each naming its position', async () => {
    // One logical answer past the Slack length limit becomes several posts. They
    // are recorded individually because a failure partway leaves the earlier ones
    // on screen, and index/of keeps them readable as one answer rather than
    // several duplicates.
    const cap = captureEvents();
    try {
        await sendSlackText('xoxb-t', target, 'x'.repeat(9000), { fetchImpl: okFetch() });
        const recorded = posts(cap.events);
        assert.ok(recorded.length > 1);
        const of = recorded[0]?.payload['of'] as number;
        assert.equal(recorded.length, of);
        assert.deepEqual(recorded.map(r => r.payload['index']), recorded.map((_, i) => i));
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

test('a chunk that failed after earlier ones landed still records what is on screen', async () => {
    // The direction that hides a duplicate: recording once on full success meant a
    // chunked answer whose later chunk failed put messages on screen and recorded
    // nothing at all.
    let n = 0;
    const failLater = (async () => {
        n += 1;
        const body = n >= 2
            ? { ok: false, error: 'channel_not_found' }
            : { ok: true, ts: '170000000.000100' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const cap = captureEvents();
    try {
        const result = await sendSlackText('xoxb-t', target, 'x'.repeat(9000), { fetchImpl: failLater });
        assert.equal(result.ok, false);
        // The first chunk did land, so exactly one post is recorded.
        assert.equal(posts(cap.events).length, 1);
    } finally { cap.restore(); }
});

test('the two records are distinct and must not be summed', async () => {
    // A send through the choke point emits outbound.send AND lands here, so adding
    // the two counts double-counts every nested path. slack.post is the
    // post-level count; outbound.send is the request-level one.
    const cap = captureEvents();
    try {
        await sendSlackText('xoxb-t', target, 'hi', { fetchImpl: okFetch() });
        const names = cap.events.map(e => e.name);
        assert.deepEqual(names, ['slack.post']);
        // Named differently on purpose: a census must pick one level, not add them.
        assert.notEqual('slack.post', 'outbound.send');
    } finally { cap.restore(); }
});
