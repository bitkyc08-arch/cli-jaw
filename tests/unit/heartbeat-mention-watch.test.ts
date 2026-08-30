// The mention-watch tick against the REAL sqlite bookkeeping (isolated
// CLI_JAW_HOME temp DB via tests/setup/test-home.ts). The durable half is the
// part worth testing: an in-memory fake would pass while the frontier, the
// receipts and the resume bound all disagreed on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMentionWatchTick } from '../../src/memory/heartbeat-mention-watch.ts';
import type { MentionWatchDeps } from '../../src/memory/heartbeat-mention-watch.ts';
import type { MentionHit } from '../../src/slack/mention-watch.ts';
import { clearMentionWatchState, findMentionWatchSeen, getMentionWatchCursor, getMentionWatchRotation } from '../../src/core/db.ts';
import type { HeartbeatMentionWatch } from '../../src/core/config.ts';
import { recordSelfDelivery, resetTurnDeliveryState, wasSelfDelivered } from '../../src/messaging/turn-delivery.ts';

const SUJI = 'U08PYEQACDN';
const MENTION = '<@' + SUJI + '>';
const CHANNEL = 'C0BDW33068P';

function watchConfig(overrides: Partial<HeartbeatMentionWatch> = {}): HeartbeatMentionWatch {
    return { channel: 'slack', userId: SUJI, channelIds: [CHANNEL], ...overrides };
}

/** Slack history over a fixed message set, both bounds exclusive. */
function historyFetch(byChannel: Record<string, Array<{ ts: string; text: string; user?: string }>>) {
    const reads: string[] = [];
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const channel = params.get('channel') || '';
        const oldest = params.get('oldest') || undefined;
        reads.push(channel);
        const all = byChannel[channel] ?? [];
        const inRange = all.filter(m => (oldest ? Number(m.ts) > Number(oldest) : true));
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({
                ok: true,
                messages: [...inRange].sort((a, b) => Number(b.ts) - Number(a.ts)),
                has_more: false,
            }),
        };
    }) as unknown as typeof fetch;
    return { impl, reads };
}

type Recorder = { asked: MentionHit[]; sent: Array<{ hit: MentionHit; text: string }> };

function deps(
    impl: typeof fetch,
    overrides: Partial<MentionWatchDeps> = {},
): { deps: MentionWatchDeps; recorder: Recorder } {
    const recorder: Recorder = { asked: [], sent: [] };
    return {
        recorder,
        deps: {
            token: 'xoxb-test',
            selfUserId: 'U0BR8UB1AAX',
            allowlist: [CHANNEL],
            fetchImpl: impl,
            yieldNow: () => null,
            answer: async (hit) => { recorder.asked.push(hit); return 'answer for ' + hit.ts; },
            send: async (hit, text) => { recorder.sent.push({ hit, text }); return true; },
            ...overrides,
        },
    };
}

function job(id: string) {
    clearMentionWatchState(id);
    return { id, name: id };
}

test('answers a mention in its thread and records the receipt', async () => {
    const id = job('mw_basic').id;
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '100.000100', text: MENTION + ' 이거 어떻게 생각해?', user: 'U0BME0C36SV' }],
    });
    const { deps: d, recorder } = deps(impl);
    const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);

    assert.equal(result.answered, 1);
    assert.equal(result.failed, 0);
    assert.equal(recorder.sent.length, 1);
    assert.equal(recorder.sent[0]?.hit.threadTs, '100.000100');
    // The cursor passes the answered message, which is what makes the next tick
    // cheap. Its receipt is pruned in the same step precisely BECAUSE the cursor
    // now covers it: the next scan reads strictly above, so it can never be
    // consulted again. Idempotence after this point is the cursor's job, and the
    // next test is the one that proves it.
    const cursor = getMentionWatchCursor.get(id, CHANNEL) as { last_ts?: string } | undefined;
    assert.equal(cursor?.last_ts, '100.000100');
    assert.equal(findMentionWatchSeen.get(id, CHANNEL, '100.000100'), undefined);
});

test('an answered mention below an unanswered one keeps the channel pinned', async () => {
    // One failed send holds the whole channel: the cursor may not pass a message
    // this tick could not answer, even though a LATER one succeeded.
    const id = job('mw_partial').id;
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '150.000100', text: MENTION + ' 첫 질문', user: 'U0BME0C36SV' },
            { ts: '150.000200', text: MENTION + ' 둘째 질문', user: 'U0BME0C36SV' },
        ],
    });
    const { deps: d } = deps(impl, {
        send: async (hit) => hit.ts !== '150.000100',
    });
    const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);
    assert.equal(result.failed, 1);
    assert.equal(result.answered, 1);
    const cursor = getMentionWatchCursor.get(id, CHANNEL) as { last_ts?: string } | undefined;
    assert.ok(!cursor?.last_ts, 'cursor moved past a mention that failed to send');
    // The delivered one keeps its receipt, so the retry tick does not re-answer it.
    assert.notEqual(findMentionWatchSeen.get(id, CHANNEL, '150.000200'), undefined);
});

test('a second tick does not answer the same message twice', async () => {
    const id = job('mw_idempotent').id;
    const messages = [{ ts: '200.000100', text: MENTION + ' 확인해줘', user: 'U0BME0C36SV' }];
    for (let tick = 0; tick < 2; tick += 1) {
        const { impl } = historyFetch({ [CHANNEL]: messages });
        const { deps: d, recorder } = deps(impl);
        const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);
        assert.equal(result.answered, tick === 0 ? 1 : 0, 'tick ' + tick);
        assert.equal(recorder.sent.length, tick === 0 ? 1 : 0, 'tick ' + tick);
    }
});

test('a failed send leaves no receipt, so the next tick retries it', async () => {
    const id = job('mw_send_fails').id;
    const messages = [{ ts: '300.000100', text: MENTION + ' 답 좀', user: 'U0BME0C36SV' }];
    const first = historyFetch({ [CHANNEL]: messages });
    const { deps: d1 } = deps(first.impl, { send: async () => false });
    const failed = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d1);
    assert.equal(failed.failed, 1);
    assert.equal(failed.answered, 0);
    assert.equal(findMentionWatchSeen.get(id, CHANNEL, '300.000100'), undefined);
    // The frontier must NOT have moved past an undelivered message.
    const stalled = getMentionWatchCursor.get(id, CHANNEL) as { last_ts?: string } | undefined;
    assert.ok(!stalled?.last_ts, 'cursor moved past an undelivered mention');

    const second = historyFetch({ [CHANNEL]: messages });
    const { deps: d2, recorder } = deps(second.impl);
    const retried = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d2);
    assert.equal(retried.answered, 1);
    assert.equal(recorder.sent.length, 1);
});

test('a quiet answer is recorded, so the agent is not asked again', async () => {
    const id = job('mw_quiet').id;
    const messages = [{ ts: '400.000100', text: MENTION + ' 참고만', user: 'U0BME0C36SV' }];
    const first = historyFetch({ [CHANNEL]: messages });
    const { deps: d1, recorder: r1 } = deps(first.impl, { answer: async () => null });
    const quiet = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d1);
    assert.equal(quiet.quiet, 1);
    assert.equal(r1.sent.length, 0);

    const second = historyFetch({ [CHANNEL]: messages });
    const { deps: d2, recorder: r2 } = deps(second.impl);
    await runMentionWatchTick(id, { id, name: id }, watchConfig(), d2);
    assert.equal(r2.asked.length, 0, 'a decided-quiet message was asked again');
});

test('a yield between items abandons the rest of the batch', async () => {
    const id = job('mw_yield').id;
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '500.000100', text: MENTION + ' 첫째', user: 'U0BME0C36SV' },
            { ts: '500.000200', text: MENTION + ' 둘째', user: 'U0BME0C36SV' },
            { ts: '500.000300', text: MENTION + ' 셋째', user: 'U0BME0C36SV' },
        ],
    });
    let calls = 0;
    const { deps: d, recorder } = deps(impl, {
        // Busy from the second item onward: a user started typing during the
        // first answer, and they outrank the rest of this backlog.
        yieldNow: () => { calls += 1; return calls > 1 ? 'yielded' : null; },
    });
    const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);
    assert.equal(result.answered, 1);
    assert.equal(result.stoppedBecause, 'yielded');
    assert.equal(recorder.sent.length, 1);
    // The two it did not reach must remain unrecorded for the next tick.
    assert.equal(findMentionWatchSeen.get(id, CHANNEL, '500.000200'), undefined);
    assert.equal(findMentionWatchSeen.get(id, CHANNEL, '500.000300'), undefined);
});

test('channels outside the live allowlist are skipped, not scanned', async () => {
    // Re-derived every tick: the allowlist can shrink after the job was saved,
    // and an answer addressed to a dropped channel would be refused with a 403.
    const id = job('mw_allowlist').id;
    const { impl, reads } = historyFetch({ [CHANNEL]: [] });
    const { deps: d } = deps(impl, { allowlist: ['C_ONLY_THIS'] });
    const result = await runMentionWatchTick(
        id, { id, name: id }, watchConfig({ channelIds: [CHANNEL, 'C_ONLY_THIS'] }), d,
    );
    assert.deepEqual(result.unauthorized, [CHANNEL]);
    assert.deepEqual(reads, ['C_ONLY_THIS']);
});

test('every channel being unauthorized asks Slack for nothing', async () => {
    const id = job('mw_all_denied').id;
    const { impl, reads } = historyFetch({ [CHANNEL]: [] });
    const { deps: d } = deps(impl, { allowlist: ['C_SOMEWHERE_ELSE'] });
    const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);
    assert.deepEqual(reads, []);
    assert.deepEqual(result.unauthorized, [CHANNEL]);
    assert.equal(result.answered, 0);
});

test('the rotation anchor is persisted for the next tick', async () => {
    const id = job('mw_rotation').id;
    const { impl } = historyFetch({ [CHANNEL]: [], C_SECOND: [] });
    const { deps: d } = deps(impl, { allowlist: [CHANNEL, 'C_SECOND'] });
    await runMentionWatchTick(id, { id, name: id }, watchConfig({ channelIds: [CHANNEL, 'C_SECOND'] }), d);
    const rotation = getMentionWatchRotation.get(id) as { last_channel_id?: string } | undefined;
    assert.equal(rotation?.last_channel_id, 'C_SECOND');
});

test('an empty allowlist scans nothing, because those sends would 403', async () => {
    // `authorizeExplicitTarget` vouches only for conversations this process has
    // evidence for when no allowlist is configured, so reading these channels
    // would find mentions, pay for answers, and get 403 on every send.
    const id = job('mw_no_allowlist').id;
    const { impl, reads } = historyFetch({
        [CHANNEL]: [{ ts: '650.000100', text: MENTION + ' 답해줘', user: 'U0BME0C36SV' }],
    });
    const { deps: d, recorder } = deps(impl, { allowlist: [] });
    const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);
    assert.deepEqual(reads, []);
    assert.deepEqual(result.unauthorized, [CHANNEL]);
    assert.equal(recorder.asked.length, 0);
});

test('an agent that posted the answer itself is not answered twice', async () => {
    // The prompt tells the agent the server posts, and `/api/channel/send` stays
    // reachable. When it uses it, these words are already in the thread; posting
    // them again is exactly the duplicate the user reported.
    const id = job('mw_self_delivered').id;
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '800.000100', text: MENTION + ' 이거 어때?', user: 'U0BME0C36SV' }],
    });
    resetTurnDeliveryState();
    const answerText = '제 생각은 이렇습니다';
    const posts: string[] = [];
    const { deps: d } = deps(impl, {
        answer: async (hit) => {
            // Stand in for the agent calling POST /api/channel/send mid-turn.
            recordSelfDelivery({
                target: { channel: 'slack', targetId: hit.channelId, threadId: hit.threadTs } as never,
                channel: 'slack', text: answerText,
            });
            return answerText;
        },
        send: async (_hit, text) => { posts.push(text); return true; },
    });
    // The real path reads its anchor and consults the claim; the fake `send` here
    // would hide that, so the check lives in heartbeat.ts and this test proves the
    // claim is visible and matches at the moment the send would run.
    const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);
    assert.equal(result.answered, 1);
    assert.equal(
        wasSelfDelivered({
            target: { channel: 'slack', targetId: CHANNEL, threadId: '800.000100' } as never,
            text: answerText, since: 0,
        }),
        true,
        'the agent self-delivery claim was not visible to the send path',
    );
});

test('nothing found means the agent is never invoked', async () => {
    const id = job('mw_empty').id;
    const { impl } = historyFetch({ [CHANNEL]: [{ ts: '600.000100', text: '관계 없는 잡담', user: 'U0BME0C36SV' }] });
    const { deps: d, recorder } = deps(impl);
    const result = await runMentionWatchTick(id, { id, name: id }, watchConfig(), d);
    assert.equal(result.answered, 0);
    assert.equal(recorder.asked.length, 0, 'the agent was invoked with no mentions to answer');
});
