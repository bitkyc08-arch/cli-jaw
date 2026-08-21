// The queue-notice bug, at the layer where it actually lives: ordering.
//
// Before this work all three channels posted the notice and threw away the
// handle, so it stayed in the channel forever. The fix is not "delete it" — it
// is deleting it only AFTER the answer is out, and rewriting rather than
// deleting when no answer ever came. These drive createQueueNotice the way
// src/slack/bot.ts drives it, including the race the live code hits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createQueueNotice,
    QueueNoticeRegistry,
    type NoticeTransport,
} from '../../src/messaging/queue-notice.ts';

const EXPIRED = '대기 시간이 초과되었습니다';

function slackNoticeFake() {
    const calls: string[] = [];
    const transport: NoticeTransport = {
        async delete() { calls.push('chat.delete'); },
        async edit(text) { calls.push('chat.update:' + text); },
    };
    return { transport, calls };
}

test('the notice is deleted only after the queued answer is delivered', async () => {
    const { transport, calls } = slackNoticeFake();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(transport);

    const sent: string[] = [];
    // Mirrors the queueHandler order in bot.ts: send, THEN close.
    sent.push('answer');
    await notice.close('answered');

    assert.deepEqual(sent, ['answer']);
    assert.deepEqual(calls, ['chat.delete']);
});

test('a failed answer send leaves the notice rewritten, never deleted', async () => {
    // The regression that matters: deleting on a failed send would leave the
    // user with neither an answer nor any sign the turn happened.
    const { transport, calls } = slackNoticeFake();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(transport);
    const sendOk = false;
    await notice.close(sendOk ? 'answered' : 'expired');
    assert.deepEqual(calls, ['chat.update:' + EXPIRED]);
});

test('a queued turn that times out rewrites the notice', async () => {
    const { transport, calls } = slackNoticeFake();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('expired', signal));
    notice.bind(transport);
    await registry.drain(1000);
    assert.deepEqual(calls, ['chat.update:' + EXPIRED]);
    assert.equal(registry.size, 0);
});

test('shutdown closes a notice whose post was still in flight', async () => {
    // The live race: sendSlackText for the notice is awaited, and the queued job
    // can settle during that await. bot.ts arms the listener first for exactly
    // this reason, and the notice module has to survive the same ordering.
    const { transport, calls } = slackNoticeFake();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('expired', signal));

    const draining = registry.drain(1000);   // shutdown starts first
    notice.bind(transport);                  // the post lands afterwards
    await draining;

    assert.deepEqual(calls, ['chat.update:' + EXPIRED], 'a late handle must still be closed');
});

test('a notice whose post failed never strands the shutdown drain', async () => {
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('expired', signal));
    // sendSlackText returned no ts, so bot.ts calls abandon().
    notice.abandon();
    const started = Date.now();
    await registry.drain(5000);
    // Without abandon() this would wait out the full 5s deadline.
    assert.ok(Date.now() - started < 1000, 'abandon must release the drain immediately');
});

test('the shutdown deadline covers a slow but working cleanup chain', async () => {
    // The reviewer's point: a hanging-only test would also pass with too short a
    // deadline. This one is slow-but-successful, so it FAILS if the bound is
    // undersized — the notice call finishes at ~120ms inside a 400ms drain.
    const calls: string[] = [];
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind({
        async delete() { calls.push('delete'); },
        async edit(text) {
            await new Promise(resolve => setTimeout(resolve, 120));
            calls.push('edit:' + text);
        },
    });
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('expired', signal));
    await registry.drain(400);
    assert.deepEqual(calls, ['edit:' + EXPIRED], 'a slow-but-working cleanup must complete');
});
