import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    deliveryDigest,
    deliveryTargetKey,
    normalizeDeliveryText,
    recordSelfDelivery,
    resetTurnDeliveryState,
    selfDeliveredFiles,
    wasSelfDelivered,
    SELF_DELIVERY_TTL_MS,
} from '../../src/messaging/turn-delivery.js';
import type { RemoteTarget } from '../../src/messaging/types.js';

const channelTarget: RemoteTarget = {
    channel: 'slack',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId: 'C0AHQE1G8MD',
};

const threadTarget: RemoteTarget = { ...channelTarget, threadId: '1787574982.237129' };

const otherTarget: RemoteTarget = { ...channelTarget, targetId: 'C08VC7AMVUL' };

const ANSWER = '다음 주 금요일 9/4까지 v1.0이다. 이번 배포는 카탈로그 뼈대다.';

test('the reported defect: an answer the agent already delivered is not posted again', () => {
    resetTurnDeliveryState();
    const turnStartedAt = 1_000_000;
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: turnStartedAt + 10 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turnStartedAt, now: turnStartedAt + 20 }),
        true,
    );
});

test('an answer nobody delivered is still posted', () => {
    resetTurnDeliveryState();
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: 1_000_000 }), false);
});

test('a DIFFERENT answer is still posted even when the agent sent something else', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: '작업을 시작합니다.', now: 1_000_010 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: 1_000_000, now: 1_000_020 }),
        false,
    );
});

test('a delivery to another conversation never suppresses this one', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({ target: otherTarget, channel: 'slack', text: ANSWER, now: 1_000_010 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: 1_000_000, now: 1_000_020 }),
        false,
    );
});

test('a thread reply and a channel post are different destinations', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({ target: threadTarget, channel: 'slack', text: ANSWER, now: 1_000_010 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: 1_000_000, now: 1_000_020 }),
        false,
    );
    assert.equal(
        wasSelfDelivered({ target: threadTarget, text: ANSWER, since: 1_000_000, now: 1_000_020 }),
        true,
    );
});

test('formatting-only differences still count as the same message', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: `${ANSWER}   \n\n\n`, now: 1_000_010 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: `${ANSWER}\n`, since: 1_000_000, now: 1_000_020 }),
        true,
    );
});

test('emphasis is not formatting noise: a differently marked-up answer is posted', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: 1_000_010 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: `*${ANSWER}*`, since: 1_000_000, now: 1_000_020 }),
        false,
    );
});

test('an expired claim fails open: the answer is posted rather than lost', () => {
    resetTurnDeliveryState();
    const start = 1_000_000;
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: start });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: start, now: start + SELF_DELIVERY_TTL_MS - 1 }),
        true,
    );
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: start });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: start, now: start + SELF_DELIVERY_TTL_MS + 1 }),
        false,
    );
});

test('empty text neither records nor suppresses', () => {
    resetTurnDeliveryState();
    assert.equal(recordSelfDelivery({ target: channelTarget, channel: 'slack', text: '   ' }), null);
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: '', since: 1_000_000, now: 1_000_020 }),
        false,
    );
});

test('a send with no usable target is not recorded', () => {
    resetTurnDeliveryState();
    assert.equal(deliveryTargetKey(undefined), null);
    assert.equal(
        recordSelfDelivery({ target: { ...channelTarget, targetId: '' }, channel: 'slack', text: ANSWER }),
        null,
    );
});

test('a file the agent already uploaded is not relayed again', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({
        target: channelTarget, channel: 'slack', text: ANSWER,
        filePath: '/Users/jun/output/home-v10-backlog-0904.png',
        now: 1_000_010,
    });
    const files = selfDeliveredFiles({ target: channelTarget, since: 1_000_000, now: 1_000_020 });
    assert.equal(files.has('/Users/jun/output/home-v10-backlog-0904.png'), true);
    assert.equal(files.has('/Users/jun/output/other.png'), false);
    assert.equal(selfDeliveredFiles({ target: otherTarget, since: 1_000_000, now: 1_000_020 }).size, 0);
});

// ─── The silence cases. These matter more than the duplicate ───────────────
// A repeated answer is a nuisance; a swallowed one is the user losing work they
// waited for, with nothing on screen to tell them.

test('a LATER turn producing the same answer is still delivered', () => {
    resetTurnDeliveryState();
    const turnOne = 1_000_000;
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: '완료했습니다.', now: turnOne + 10 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: '완료했습니다.', since: turnOne, now: turnOne + 20 }),
        true,
    );
    // The user asks again two minutes later and the agent does NOT self-send.
    const turnTwo = turnOne + 120_000;
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: '완료했습니다.', since: turnTwo, now: turnTwo + 10 }),
        false,
        'a claim from an earlier turn must never suppress a later turn',
    );
});

test('one claim answers for exactly one post', () => {
    resetTurnDeliveryState();
    const start = 1_000_000;
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: start + 10 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: start, now: start + 20 }),
        true,
    );
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: start, now: start + 20 }),
        false,
        'a consumed claim must not suppress a second post',
    );
});

test('a file sent in an earlier turn is uploaded again when asked for again', () => {
    resetTurnDeliveryState();
    const turnOne = 1_000_000;
    recordSelfDelivery({
        target: channelTarget, channel: 'slack', text: ANSWER,
        filePath: '/Users/jun/output/chart.png', now: turnOne + 10,
    });
    assert.equal(selfDeliveredFiles({ target: channelTarget, since: turnOne, now: turnOne + 20 }).size, 1);
    const turnTwo = turnOne + 120_000;
    assert.equal(
        selfDeliveredFiles({ target: channelTarget, since: turnTwo, now: turnTwo + 10 }).size,
        0,
        'a re-requested file must be uploaded again',
    );
});

test('a missing turn anchor suppresses nothing', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: 1_000_010 });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: Number.NaN, now: 1_000_020 }),
        false,
    );
    assert.equal(selfDeliveredFiles({ target: channelTarget, since: Number.NaN, now: 1_000_020 }).size, 0);
});

test('normalization and digests are stable and text-sensitive', () => {
    assert.equal(normalizeDeliveryText('a  \r\n\n\n\nb  '), 'a\n\nb');
    assert.equal(deliveryDigest(''), null);
    assert.equal(deliveryDigest(null), null);
    assert.equal(deliveryDigest('a'), deliveryDigest('a\n'));
    assert.notEqual(deliveryDigest('a'), deliveryDigest('b'));
});
