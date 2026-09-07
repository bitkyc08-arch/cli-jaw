// The Slack context block: what the agent is told about WHERE it is.
//
// The load-bearing assertions are the ones about the channel id and thread ts —
// those are the reply address (issue #315) and must survive every input — and
// the trust note, which must survive every data volume.


import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSlackContextBlock,
    applySlackContext,
    SLACK_TRUST_NOTE,
} from '../../src/slack/context.ts';
import type { SlackIdentity } from '../../src/slack/identity.ts';
import type { SlackConversationInfo, SlackThreadInfo } from '../../src/slack/conversation.ts';

const sender: SlackIdentity = {
    id: 'U04XYZ', name: '김병준', kind: 'user', isBot: false, resolved: true,
};

const channel = (over: Partial<SlackConversationInfo> = {}): SlackConversationInfo => ({
    id: 'C0A1B2C3', name: 'eng-platform', kind: 'channel', resolved: true, ...over,
});

const thread = (over: Partial<SlackThreadInfo> = {}): SlackThreadInfo => ({
    threadTs: '1754983201.123456', replyCount: 12, participants: [], resolved: true, ...over,
});

// ─── the reply address ──────────────────────────────

test('the block carries the channel id verbatim', () => {
    const block = buildSlackContextBlock({ identity: sender, conversation: channel() });
    assert.ok(block.includes('C0A1B2C3'), 'the channel id IS the lookup argument');
});

test('a threaded message carries the thread ts verbatim', () => {
    const block = buildSlackContextBlock({
        identity: sender, conversation: channel(), thread: thread(),
    });
    assert.ok(block.includes('1754983201.123456'));
    assert.ok(block.includes('답장 12개'));
});

test('a top-level message has no thread clause at all', () => {
    const block = buildSlackContextBlock({ identity: sender, conversation: channel() });
    assert.ok(!block.includes('스레드'), 'an empty thread field would be worse than none');
});

test('the ids survive a maximal name, topic, participants and roster', () => {
    const long = (n: number) => 'ㄱ'.repeat(n);
    const participants = Array.from({ length: 12 }, (_, i) => ({
        id: `U${String(i).padStart(6, '0')}`, name: long(64), isBot: false,
    }));
    const block = buildSlackContextBlock({
        identity: { ...sender, name: long(64) },
        conversation: channel({ name: long(64), topic: long(64) }),
        thread: thread({ participants }),
        roster: { names: Array.from({ length: 8 }, () => long(64)), total: 200 },
    });
    assert.ok(block.includes('C0A1B2C3'), 'the channel id must never be truncated away');
    assert.ok(block.includes('1754983201.123456'), 'nor the thread ts');
});

// ─── the trust boundary ─────────────────────────────

test('the complete trust note survives a maximal block', () => {
    const long = (n: number) => 'ㄱ'.repeat(n);
    const participants = Array.from({ length: 12 }, (_, i) => ({
        id: `U${i}`, name: long(64), isBot: false,
    }));
    const block = buildSlackContextBlock({
        identity: { ...sender, name: long(64) },
        conversation: channel({ name: long(64), topic: long(64) }),
        thread: thread({ participants }),
        roster: { names: Array.from({ length: 8 }, () => long(64)), total: 200 },
    });
    assert.ok(
        block.endsWith(SLACK_TRUST_NOTE),
        'a defense that disappears once there is enough data is not a defense',
    );
});

test('a block of raw ids carries no trust note — there is nothing to mislabel', () => {
    const block = buildSlackContextBlock({
        identity: { id: 'U1', name: 'U1', kind: 'user', isBot: false, resolved: false },
        conversation: channel({ name: 'C0A1B2C3', resolved: false }),
    });
    assert.ok(!block.includes(SLACK_TRUST_NOTE));
});

test('an emoji name is not split mid-surrogate', () => {
    const block = buildSlackContextBlock({
        identity: { ...sender, name: '🙂'.repeat(80) },
        conversation: channel(),
    });
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(block), 'no lone high surrogate');
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(block), 'no lone low surrogate');
});

// ─── participants ───────────────────────────────────

test('a lone participant adds no line — it would just repeat the sender', () => {
    const block = buildSlackContextBlock({
        identity: sender,
        conversation: channel(),
        thread: thread({ participants: [{ id: 'U04XYZ', name: '김병준', isBot: false }] }),
    });
    assert.ok(!block.includes('대화 참여자'));
});

test('participants are listed with their ids', () => {
    const block = buildSlackContextBlock({
        identity: sender,
        conversation: channel(),
        thread: thread({ participants: [
            { id: 'U04XYZ', name: '김병준', isBot: false },
            { id: 'U07ABC', name: '이수진', isBot: false },
        ] }),
    });
    assert.ok(block.includes('이수진 (U07ABC)'));
});

test('our own messages are marked bot(self) by user id OR bot id', () => {
    // A granular-permission app message carries both; participants key on the
    // bot id while auth.test gives us the user id.
    const byUser = buildSlackContextBlock({
        identity: sender, conversation: channel(), selfUserId: 'U0SELF',
        thread: thread({ participants: [
            { id: 'U1', name: 'a', isBot: false },
            { id: 'U0SELF', name: 'jaw', isBot: true },
        ] }),
    });
    assert.ok(byUser.includes('bot(self)'));

    const byBotId = buildSlackContextBlock({
        identity: sender, conversation: channel(), selfUserId: 'U0SELF',
        thread: thread({ participants: [
            { id: 'U1', name: 'a', isBot: false },
            { id: 'B0BOT', name: 'jaw', isBot: true, userId: 'U0SELF' },
        ] }),
    });
    assert.ok(byBotId.includes('bot(self)'), 'the carried user id must also match');
});

test('an over-budget participant list drops whole entries, never half an id', () => {
    const participants = Array.from({ length: 12 }, (_, i) => ({
        id: `U${String(i).padStart(6, '0')}`, name: 'ㄱ'.repeat(64), isBot: false,
    }));
    const block = buildSlackContextBlock({
        identity: sender, conversation: channel(), thread: thread({ participants }),
    });
    const line = block.split('\n').find(l => l.startsWith('[대화 참여자]'))!;
    assert.ok(line.includes('외 '), 'the drop is reported, not silent');
    // Every id that appears must appear in full.
    for (const match of line.matchAll(/U\d{6}/g)) {
        assert.equal(match[0].length, 7);
    }
});

// ─── conversation kinds ─────────────────────────────

test('a DM is labelled DM, a group DM is labelled 그룹 DM', () => {
    const dm = buildSlackContextBlock({
        identity: sender, conversation: channel({ id: 'D1', kind: 'dm', name: 'D1' }),
    });
    assert.ok(dm.includes('DM'));
    assert.ok(dm.includes('D1'));

    const mpim = buildSlackContextBlock({
        identity: sender, conversation: channel({ id: 'G1', kind: 'group_dm', name: 'G1' }),
    });
    assert.ok(mpim.includes('그룹 DM'));
});

test('an unresolved conversation still exposes its id', () => {
    const block = buildSlackContextBlock({
        identity: sender, conversation: { id: 'C9', name: 'C9', kind: 'channel', resolved: false },
    });
    assert.ok(block.includes('C9'), 'the id is what the agent needs, resolved or not');
});

// ─── roster ─────────────────────────────────────────

test('the roster line labels the count honestly', () => {
    const exact = buildSlackContextBlock({
        identity: sender, conversation: channel(),
        roster: { names: ['a', 'b'], total: 42 },
    });
    assert.ok(exact.includes('전체 42명'));

    const approximate = buildSlackContextBlock({
        identity: sender, conversation: channel(),
        roster: { names: ['a', 'b'], total: 42, approximate: true },
    });
    assert.ok(approximate.includes('전체 최소 42명'), 'a truncated walk is a lower bound');
});

// ─── assembly ───────────────────────────────────────

test('applySlackContext prefixes the block and leaves the body intact', () => {
    const out = applySlackContext('[Slack] x', 'hello');
    assert.equal(out, '[Slack] x\nhello');
});

test('an empty block returns the message untouched', () => {
    assert.equal(applySlackContext('', 'hello'), 'hello');
});

test('nothing to say produces an empty block, not a header with holes', () => {
    const block = buildSlackContextBlock({
        identity: { id: '', name: '', kind: 'unknown', isBot: false, resolved: false },
    });
    assert.equal(block, '');
});

test('the whole block stays within its cap', () => {
    const long = (n: number) => 'ㄱ'.repeat(n);
    const participants = Array.from({ length: 12 }, (_, i) => ({
        id: `U${i}`, name: long(64), isBot: false,
    }));
    const block = buildSlackContextBlock({
        identity: { ...sender, name: long(64) },
        conversation: channel({ name: long(64), topic: long(64) }),
        thread: thread({ participants }),
        roster: { names: Array.from({ length: 8 }, () => long(64)), total: 200 },
    });
    assert.ok([...block].length <= 1200, `block was ${[...block].length} code points`);
});
