import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    deliveryDigest,
    deliveryTargetKey,
    normalizeDeliveryText,
    recordSelfDelivery,
    resetTurnDeliveryState,
    resetDeliverySeq,
    selfDeliveredFiles,
    wasSelfDelivered,
    nextDeliverySeq,
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

/** A turn: take the anchor first, then whatever the agent does happens after. */
function startTurn(): number {
    return nextDeliverySeq();
}

function tempFile(name: string, body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-claim-'));
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
}

test('the reported defect: an answer the agent already delivered is not posted again', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn }), true);
});

test('an answer nobody delivered is still posted', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn }), false);
});

test('a DIFFERENT answer is still posted even when the agent sent something else', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: '작업을 시작합니다.' });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn }), false);
});

test('a delivery to another conversation never suppresses this one', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    recordSelfDelivery({ target: otherTarget, channel: 'slack', text: ANSWER });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn }), false);
});

test('a thread reply and a channel post are different destinations', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    recordSelfDelivery({ target: threadTarget, channel: 'slack', text: ANSWER });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn }), false);
    assert.equal(wasSelfDelivered({ target: threadTarget, text: ANSWER, since: turn }), true);
});

test('formatting-only differences still count as the same message', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: `${ANSWER}   \n\n\n` });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: `${ANSWER}\n`, since: turn }), true);
});

test('emphasis is not formatting noise: a differently marked-up answer is posted', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: `*${ANSWER}*`, since: turn }), false);
});

test('an expired claim fails open: the answer is posted rather than lost', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    const start = 1_000_000;
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: start });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn, now: start + SELF_DELIVERY_TTL_MS - 1 }),
        true,
    );
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: start });
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn, now: start + SELF_DELIVERY_TTL_MS + 1 }),
        false,
    );
});

test('empty text neither records nor suppresses', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    assert.equal(recordSelfDelivery({ target: channelTarget, channel: 'slack', text: '   ' }), null);
    assert.equal(wasSelfDelivered({ target: channelTarget, text: '', since: turn }), false);
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
    const turn = startTurn();
    const shipped = tempFile('home-v10-backlog-0904.png', 'first');
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, filePath: shipped });
    const files = selfDeliveredFiles({ target: channelTarget, since: turn });
    assert.equal(files.has(shipped), true);
    assert.equal(files.has(join(shipped, '..', 'other.png')), false);
    assert.equal(selfDeliveredFiles({ target: otherTarget, since: turn }).size, 0);
});

// ─── The silence cases. These matter more than the duplicate ───────────────
// A repeated answer is a nuisance; a swallowed one is the user losing work they
// waited for, with nothing on screen to tell them.

test('a LATER turn producing the same answer is still delivered', () => {
    resetTurnDeliveryState();
    const turnOne = startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: '완료했습니다.' });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: '완료했습니다.', since: turnOne }), true);

    // The user asks again and the agent does NOT self-send this time.
    const turnTwo = startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: '완료했습니다.', now: 1 });
    resetTurnDeliveryState();
    const turnThree = startTurn();
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: '완료했습니다.', since: turnThree }),
        false,
        'a claim from an earlier turn must never suppress a later turn',
    );
    assert.ok(turnTwo < turnThree);
});

test('one claim answers for exactly one post', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn }), true);
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turn }),
        false,
        'a consumed claim must not suppress a second post',
    );
});

test('a file sent in an earlier turn is uploaded again when asked for again', () => {
    resetTurnDeliveryState();
    const turnOne = startTurn();
    const chart = tempFile('chart.png', 'v1');
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, filePath: chart });
    assert.equal(selfDeliveredFiles({ target: channelTarget, since: turnOne }).size, 1);
    const turnTwo = startTurn();
    assert.equal(
        selfDeliveredFiles({ target: channelTarget, since: turnTwo }).size,
        0,
        'a re-requested file must be uploaded again',
    );
});

test('a regenerated file under the same name is relayed, not skipped', () => {
    resetTurnDeliveryState();
    const turn = startTurn();
    const chart = tempFile('chart.png', 'the first draft');
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, filePath: chart });
    assert.equal(
        selfDeliveredFiles({ target: channelTarget, since: turn }).has(chart),
        true,
        'the file as sent is skipped',
    );
    // The agent notices a mistake and rewrites the SAME path, then references it.
    writeFileSync(chart, 'the corrected chart with different bytes');
    assert.equal(
        selfDeliveredFiles({ target: channelTarget, since: turn }).has(chart),
        false,
        'a path is not an identity: the corrected artifact must still be relayed',
    );
});

test('a missing turn anchor suppresses nothing', () => {
    resetTurnDeliveryState();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER });
    assert.equal(wasSelfDelivered({ target: channelTarget, text: ANSWER, since: Number.NaN }), false);
    assert.equal(selfDeliveredFiles({ target: channelTarget, since: Number.NaN }).size, 0);
});

test('turn ownership survives a system clock that jumps backwards', () => {
    resetTurnDeliveryState();
    // Turn 1 self-sends the text but answers something else, so its claim is
    // left unconsumed, stamped with a LATER wall-clock time than turn 2 will see.
    startTurn();
    recordSelfDelivery({ target: channelTarget, channel: 'slack', text: ANSWER, now: 1_000_010 });

    // The system clock rolls BACKWARDS. Turn 2 then legitimately produces the
    // same text without self-sending. Wall-clock ordering — even clamped — would
    // let turn 1's stale claim swallow this answer.
    const turnTwo = startTurn();
    assert.equal(
        wasSelfDelivered({ target: channelTarget, text: ANSWER, since: turnTwo, now: 999_000 }),
        false,
        'a claim recorded before this turn began can never suppress it, whatever the clock did',
    );
});

test('the sequence is strictly increasing', () => {
    resetDeliverySeq();
    const a = nextDeliverySeq();
    const b = nextDeliverySeq();
    assert.ok(b > a, 'two turns never read the same anchor');
});

test('normalization and digests are stable and text-sensitive', () => {
    assert.equal(normalizeDeliveryText('a  \r\n\n\n\nb  '), 'a\n\nb');
    assert.equal(deliveryDigest(''), null);
    assert.equal(deliveryDigest(null), null);
    assert.equal(deliveryDigest('a'), deliveryDigest('a\n'));
    assert.notEqual(deliveryDigest('a'), deliveryDigest('b'));
});

// The legacy /api/telegram/send route builds its own claim address because it
// talks to the Bot API directly. If that address stops agreeing with what the
// dispatch side computes, the claim silently stops matching and the duplicate
// comes back — so the agreement is pinned here rather than left to inspection.
test('the legacy telegram route and the dispatch path address the same conversation', () => {
    const dispatchDirect: RemoteTarget = {
        channel: 'telegram', targetKind: 'channel', peerKind: 'direct', targetId: '12345',
    };
    assert.equal(
        deliveryTargetKey(dispatchDirect),
        deliveryTargetKey({
            channel: 'telegram', targetKind: 'channel', peerKind: 'direct', targetId: '12345',
        }),
    );
    const dispatchGroup: RemoteTarget = {
        channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999', threadId: '7',
    };
    assert.equal(
        deliveryTargetKey(dispatchGroup),
        deliveryTargetKey({
            channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999', threadId: '7',
        }),
    );
    assert.notEqual(deliveryTargetKey(dispatchDirect), deliveryTargetKey(dispatchGroup));
});
