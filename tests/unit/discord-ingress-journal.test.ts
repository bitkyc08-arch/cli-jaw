// Discord ingress durability (M3d).
//
// discord.durableIngress is now declared true, and that declaration is only honest if
// a restart actually remembers what it handled. The memory seen-set cannot carry that,
// so these assert the journal does, and that an unresolvable bot identity refuses
// admission instead of dropping the message.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { IngressJournal, admitIngress, settleIngress } from '../../src/messaging/durable-ingress.ts';
import { discordInboundEnvelope } from '../../src/messaging/inbound-envelope.ts';
import { capabilitiesFor } from '../../src/messaging/channel-capabilities.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const BOT = '9876543210';

function freshDb(): Database.Database {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    return database;
}

const target: RemoteTarget = {
    channel: 'discord',
    targetKind: 'channel',
    peerKind: 'channel',
    targetId: 'C777',
    guildId: 'G1',
};

function envelopeFor(messageId: string, botUserId: string | null = BOT) {
    return discordInboundEnvelope({
        botUserId,
        messageId,
        channelId: 'C777',
        authorId: 'U42',
        guildId: 'G1',
        target,
        now: () => 1_700_000_000_000,
    });
}

/** The shipped admit/settle protocol, exactly as the handler calls it. */
function handleOnce(journal: IngressJournal, messageId: string, handled: string[]): void {
    const admission = admitIngress(journal, envelopeFor(messageId), 'digest-' + messageId);
    if (!admission.admit) return;
    handled.push(messageId);
    settleIngress(journal, admission);
}

test('a message handled before a restart is not handled again after it', () => {
    const database = freshDb();
    const handled: string[] = [];

    // First process.
    handleOnce(new IngressJournal(database, { now: () => 1, bootId: 'boot-1' }), 'M1', handled);
    assert.deepEqual(handled, ['M1']);

    // Restart: new journal instance, new boot id, same database. A gateway Resume
    // redelivers the message the memory seen-set no longer remembers.
    handleOnce(new IngressJournal(database, { now: () => 2, bootId: 'boot-2' }), 'M1', handled);
    assert.deepEqual(handled, ['M1'], 'the replayed message must not be processed twice');
});

test('a message interrupted mid-flight is retried after a restart', () => {
    const database = freshDb();
    const handled: string[] = [];
    const first = new IngressJournal(database, { now: () => 1, bootId: 'boot-1' });

    // Claimed but never settled: the process died while handling it.
    const admission = admitIngress(first, envelopeFor('M2'), 'digest-M2');
    assert.equal(admission.admit, true);
    assert.equal(first.find('discord', BOT, 'M2')?.state, 'processing');

    handleOnce(new IngressJournal(database, { now: () => 2, bootId: 'boot-2' }), 'M2', handled);
    assert.deepEqual(handled, ['M2'], 'an unfinished message must get its retry');
    assert.equal(first.find('discord', BOT, 'M2')?.state, 'completed');
});

test('two distinct messages are both handled', () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot-1' });
    const handled: string[] = [];
    handleOnce(journal, 'M3', handled);
    handleOnce(journal, 'M4', handled);
    assert.deepEqual(handled, ['M3', 'M4']);
});

test('no envelope is built without a bot identity', () => {
    // client.user is null before READY and can change across reconnects, which is why
    // the handler reads it per message instead of capturing it at startup.
    assert.equal(envelopeFor('M5', null), null);
    assert.equal(envelopeFor('M5', ''), null);
});

test('a DM keys its conversation without colliding with a guild', () => {
    const dm = discordInboundEnvelope({
        botUserId: BOT,
        messageId: 'M6',
        channelId: 'D1',
        authorId: 'U42',
        guildId: null,
        target: { channel: 'discord', targetKind: 'user', peerKind: 'direct', targetId: 'D1' },
        now: () => 1,
    });
    assert.equal(dm?.conversationKey, 'discord:dm:D1');
});

test('a thread keys its conversation by the parent channel', () => {
    const thread = discordInboundEnvelope({
        botUserId: BOT,
        messageId: 'M7',
        channelId: 'T99',
        authorId: 'U42',
        guildId: 'G1',
        isThread: true,
        parentId: 'C777',
        target: { channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: 'T99', guildId: 'G1' },
        now: () => 1,
    });
    // In a thread the channel id IS the thread id, so the parent identifies the
    // conversation and every thread reply lands in the same lane.
    assert.equal(thread?.conversationKey, 'discord:G1:C777');
    assert.equal(thread?.threadKey, 'T99');
});

test('the durableIngress declaration matches what the journal actually provides', () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot-1' });
    const handled: string[] = [];
    handleOnce(journal, 'M8', handled);
    handleOnce(new IngressJournal(database, { now: () => 2, bootId: 'boot-2' }), 'M8', handled);
    assert.equal(handled.length, 1);
    // The declaration is only true because of the assertion above it.
    assert.equal(capabilitiesFor('discord').durableIngress, true);
});
