import test from 'node:test';
import assert from 'node:assert/strict';
import {
    telegramInboundEnvelope,
    slackInboundEnvelope,
    discordInboundEnvelope,
} from '../../src/messaging/inbound-envelope.ts';
import { isInboundEnvelope, type RemoteTarget } from '../../src/messaging/types.ts';

// Fixed clocks: Telegram and Discord stamp receivedAt from the adapter clock, so a
// real Date.now() would make the exact-value assertions untestable.
const TG_NOW = 1_700_000_000_000;
const DC_NOW = 1_700_000_111_000;

const telegramTarget: RemoteTarget = {
    channel: 'telegram',
    targetKind: 'channel',
    peerKind: 'group',
    targetId: '-1001234567890',
};

const slackTarget: RemoteTarget = {
    channel: 'slack',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId: 'C0ABCDEF',
    guildId: 'T0TEAM01',
};

const discordTarget: RemoteTarget = {
    channel: 'discord',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId: '900000000000000001',
    guildId: '800000000000000001',
};

const telegramInput = () => ({
    botUserId: 7654321,
    updateId: 90210,
    chatId: -1001234567890,
    fromId: 42424242,
    target: telegramTarget,
    now: () => TG_NOW,
});

const slackInput = () => ({
    teamId: 'T0TEAM01',
    channelId: 'C0ABCDEF',
    ts: '1700000000.123456',
    userId: 'U0USER01',
    envelopeId: 'env-abc-123',
    target: slackTarget,
});

const discordInput = () => ({
    botUserId: '700000000000000001',
    messageId: '950000000000000009',
    channelId: '900000000000000001',
    authorId: '600000000000000001',
    guildId: '800000000000000001',
    target: discordTarget,
    now: () => DC_NOW,
});

// ─── Happy path: every field, exactly ────────────────

test('telegramInboundEnvelope maps every field from a plain group message', () => {
    const env = telegramInboundEnvelope(telegramInput());
    assert.ok(env, 'a complete update must produce an envelope');
    assert.equal(env.channel, 'telegram');
    assert.equal(env.accountId, '7654321');
    assert.equal(env.eventId, '90210');
    assert.equal(env.conversationKey, 'telegram:-1001234567890');
    assert.equal(env.threadKey, undefined);
    assert.equal(env.actorId, '42424242');
    assert.equal(env.receivedAt, TG_NOW);
    assert.equal(env.ackPolicy, 'after-final-delivery');
    assert.equal(env.rawEnvelopeRef, 'telegram:update:90210');
    assert.deepEqual(env.target, telegramTarget);
    assert.equal(isInboundEnvelope(env), true);
});

test('slackInboundEnvelope maps every field from a top-level channel message', () => {
    const env = slackInboundEnvelope(slackInput());
    assert.ok(env, 'a complete event must produce an envelope');
    assert.equal(env.channel, 'slack');
    assert.equal(env.accountId, 'T0TEAM01');
    // Shape must stay identical to slackEventKey(team, channel, ts).
    assert.equal(env.eventId, 'T0TEAM01:C0ABCDEF:1700000000.123456');
    assert.equal(env.conversationKey, 'slack:T0TEAM01:C0ABCDEF');
    assert.equal(env.actorId, 'U0USER01');
    assert.equal(env.receivedAt, 1700000000.123456 * 1000);
    // Slack acked first until the durable append landed in front of it (M3c). The
    // policy is an observation of the transport, so it moved when the transport did.
    assert.equal(env.ackPolicy, 'after-durable-append');
    assert.equal(env.rawEnvelopeRef, 'slack:envelope:env-abc-123');
    assert.deepEqual(env.target, slackTarget);
    assert.equal(isInboundEnvelope(env), true);
});

test('discordInboundEnvelope maps every field from a guild channel message', () => {
    const env = discordInboundEnvelope(discordInput());
    assert.ok(env, 'a complete message must produce an envelope');
    assert.equal(env.channel, 'discord');
    assert.equal(env.accountId, '700000000000000001');
    assert.equal(env.eventId, '950000000000000009');
    assert.equal(env.conversationKey, 'discord:800000000000000001:900000000000000001');
    assert.equal(env.threadKey, undefined);
    assert.equal(env.actorId, '600000000000000001');
    assert.equal(env.receivedAt, DC_NOW);
    assert.equal(env.ackPolicy, 'transport-managed');
    assert.equal(env.rawEnvelopeRef, 'discord:message:950000000000000009');
    assert.deepEqual(env.target, discordTarget);
    assert.equal(isInboundEnvelope(env), true);
});

// ─── Missing accountId drops, never fabricates ───────

test('a missing accountId returns null instead of a fabricated identity', () => {
    // getMe has not returned / auth.test gave no team / client.user is null pre-READY.
    assert.equal(telegramInboundEnvelope({ ...telegramInput(), botUserId: null }), null);
    assert.equal(slackInboundEnvelope({ ...slackInput(), teamId: '' }), null);
    assert.equal(slackInboundEnvelope({ ...slackInput(), teamId: '   ' }), null);
    assert.equal(discordInboundEnvelope({ ...discordInput(), botUserId: undefined }), null);
});

test('other required fields drop the event rather than keying on a placeholder', () => {
    assert.equal(telegramInboundEnvelope({ ...telegramInput(), fromId: null }), null);
    assert.equal(telegramInboundEnvelope({ ...telegramInput(), updateId: Number.NaN }), null);
    assert.equal(slackInboundEnvelope({ ...slackInput(), userId: '', botId: '' }), null);
    // An unreadable ts is also an unusable dedupe key, so it must not fall back.
    assert.equal(slackInboundEnvelope({ ...slackInput(), ts: 'not-a-ts' }), null);
    assert.equal(discordInboundEnvelope({ ...discordInput(), messageId: '' }), null);
});

test('a bot-authored Slack event falls back to bot_id for the actor', () => {
    const env = slackInboundEnvelope({ ...slackInput(), userId: undefined, botId: 'B0BOT01' });
    assert.ok(env);
    assert.equal(env.actorId, 'B0BOT01');
    assert.equal(isInboundEnvelope(env), true);
});

// ─── Origin binding ──────────────────────────────────

test('every envelope carries a target from its own channel', () => {
    const envelopes = [
        telegramInboundEnvelope(telegramInput()),
        slackInboundEnvelope(slackInput()),
        discordInboundEnvelope(discordInput()),
    ];
    for (const env of envelopes) {
        assert.ok(env);
        assert.equal(env.target.channel, env.channel);
    }
});

test('a target from another channel is refused at the normalizer', () => {
    // Caught here as well as in isInboundEnvelope: a mismatched target would route
    // the reply to a channel the message never came from.
    assert.equal(telegramInboundEnvelope({ ...telegramInput(), target: slackTarget }), null);
    assert.equal(slackInboundEnvelope({ ...slackInput(), target: discordTarget }), null);
    assert.equal(discordInboundEnvelope({ ...discordInput(), target: telegramTarget }), null);
});

// ─── Telegram threads (forum topics) ─────────────────

test('Telegram sets threadKey only for a topic message', () => {
    const topic = telegramInboundEnvelope({
        ...telegramInput(), isTopicMessage: true, messageThreadId: 77,
    });
    assert.ok(topic);
    assert.equal(topic.threadKey, '77');
    assert.equal(isInboundEnvelope(topic), true);

    const plain = telegramInboundEnvelope(telegramInput());
    assert.ok(plain);
    assert.equal(plain.threadKey, undefined);
    assert.equal('threadKey' in plain, false, 'absent, not an undefined-valued key');

    // A message_thread_id without the topic flag is a reply id, not a topic.
    const notTopic = telegramInboundEnvelope({ ...telegramInput(), messageThreadId: 77 });
    assert.ok(notTopic);
    assert.equal(notTopic.threadKey, undefined);

    // Topic 1 is the forum's General topic — the chat itself. buildTelegramTarget
    // excludes it from threadId, so threadKey must agree.
    const general = telegramInboundEnvelope({
        ...telegramInput(), isTopicMessage: true, messageThreadId: 1,
    });
    assert.ok(general);
    assert.equal(general.threadKey, undefined);
});

// ─── Slack threads ───────────────────────────────────

test('Slack threadKey is the parent ts when the message arrived in a thread', () => {
    const env = slackInboundEnvelope({
        ...slackInput(), ts: '1700000050.000200', threadTs: '1700000000.123456',
    });
    assert.ok(env);
    assert.equal(env.threadKey, '1700000000.123456');
    // The event identity still uses the message's OWN ts.
    assert.equal(env.eventId, 'T0TEAM01:C0ABCDEF:1700000050.000200');
    assert.equal(isInboundEnvelope(env), true);
});

test('Slack top-level message uses its own ts as the thread it would open', () => {
    const env = slackInboundEnvelope(slackInput());
    assert.ok(env);
    assert.equal(env.threadKey, '1700000000.123456');

    // replyInThread: false means replies go to conversation top level, so no thread.
    const flat = slackInboundEnvelope({ ...slackInput(), replyInThread: false });
    assert.ok(flat);
    assert.equal(flat.threadKey, undefined);
});

// ─── Discord threads and DMs ─────────────────────────

test('Discord thread channel sets threadKey and keys the conversation on the parent', () => {
    const env = discordInboundEnvelope({
        ...discordInput(),
        channelId: '910000000000000005',
        isThread: true,
        parentId: '900000000000000001',
    });
    assert.ok(env);
    assert.equal(env.threadKey, '910000000000000005');
    assert.equal(env.conversationKey, 'discord:800000000000000001:900000000000000001');
    assert.equal(isInboundEnvelope(env), true);
});

test('Discord DM puts dm in the guild slot', () => {
    const dmTarget: RemoteTarget = {
        channel: 'discord',
        targetKind: 'user',
        peerKind: 'direct',
        targetId: '920000000000000007',
    };
    const env = discordInboundEnvelope({
        ...discordInput(), channelId: '920000000000000007', guildId: null, target: dmTarget,
    });
    assert.ok(env);
    assert.equal(env.conversationKey, 'discord:dm:920000000000000007');
    assert.equal(env.threadKey, undefined);
    assert.equal(isInboundEnvelope(env), true);
});

// ─── Guard rejections ────────────────────────────────

test('isInboundEnvelope rejects malformed envelopes', () => {
    const valid = discordInboundEnvelope(discordInput());
    assert.ok(valid);
    assert.equal(isInboundEnvelope(valid), true);

    // Empty accountId: cannot namespace the ingress journal.
    assert.equal(isInboundEnvelope({ ...valid, accountId: '' }), false);
    assert.equal(isInboundEnvelope({ ...valid, accountId: '   ' }), false);
    // Target from a different channel: would send the reply elsewhere.
    assert.equal(isInboundEnvelope({ ...valid, target: slackTarget }), false);
    // Unknown ack policy: the ingress journal cannot decide when to commit.
    assert.equal(isInboundEnvelope({ ...valid, ackPolicy: 'best-effort' }), false);
    // Non-finite receivedAt: unorderable.
    assert.equal(isInboundEnvelope({ ...valid, receivedAt: Number.NaN }), false);
    assert.equal(isInboundEnvelope({ ...valid, receivedAt: Number.POSITIVE_INFINITY }), false);
});

test('rawEnvelopeRef stays an opaque id, never body or credential material', () => {
    const envelopes = [
        telegramInboundEnvelope(telegramInput()),
        slackInboundEnvelope(slackInput()),
        discordInboundEnvelope(discordInput()),
    ];
    for (const env of envelopes) {
        assert.ok(env);
        assert.match(env.rawEnvelopeRef ?? '', /^[a-z]+:[a-z]+:[\w.-]+$/);
    }
    // No envelope id from Socket Mode means no correlation handle — not a guess.
    const noRef = slackInboundEnvelope({ ...slackInput(), envelopeId: undefined });
    assert.ok(noRef);
    assert.equal(noRef.rawEnvelopeRef, undefined);
    assert.equal(isInboundEnvelope(noRef), true);
});
