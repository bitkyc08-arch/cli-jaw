// The contract this file exists for: a Telegram update that was journaled but never
// completed must run exactly once across a restart, and an update the journal refuses
// must not advance the offset. Both are properties of the ORDER of three calls, so
// they are asserted through the poller rather than by reading the source.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { IngressJournal, admitIngress, settleIngress } from '../../src/messaging/durable-ingress.ts';
import { TelegramDurablePoller, TelegramUpdateOffsetStore } from '../../src/telegram/update-offset.ts';
import { telegramInboundEnvelope } from '../../src/messaging/inbound-envelope.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

const BOT = '777';
const KEY = BOT;

function freshDb(): Database.Database {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    return database;
}

function updateFor(updateId: number) {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            chat: { id: -100999, type: 'supergroup' },
            from: { id: 42 },
            text: `hello ${updateId}`,
        },
    };
}

function envelopeFor(updateId: number): InboundEnvelope {
    const envelope = telegramInboundEnvelope({
        botUserId: BOT,
        updateId,
        chatId: -100999,
        fromId: 42,
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
        now: () => 1_700_000_000_000,
    });
    assert.ok(envelope, 'fixture envelope must be valid');
    return envelope;
}

/**
 * Calls the SHIPPED admit/settle protocol, not a copy of it. Only the envelope and the
 * handler body are local; the ordering under test is the production one, so a change to
 * it fails here rather than passing against a parallel implementation.
 */
function journaledHandler(
    journal: IngressJournal,
    handled: number[],
    handler: (updateId: number) => void = () => {},
) {
    return async (update: { update_id: number }) => {
        const admission = admitIngress(journal, envelopeFor(update.update_id), `digest-${update.update_id}`);
        if (!admission.admit) return;
        try {
            handler(update.update_id);
            handled.push(update.update_id);
            settleIngress(journal, admission);
        } catch (error) {
            settleIngress(journal, admission, error);
            throw error;
        }
    };
}

function pollerFor(
    database: Database.Database,
    journal: IngressJournal,
    updates: Array<{ update_id: number }>,
    handled: number[],
    handler?: (updateId: number) => void,
) {
    const store = new TelegramUpdateOffsetStore(database);
    let served = false;
    const api = {
        getUpdates: async (opts: { offset: number }) => {
            if (opts.offset === -1) return [];
            if (served) return [];
            served = true;
            return updates.filter(u => u.update_id >= opts.offset);
        },
        deleteWebhook: async () => true,
    };
    return {
        store,
        poller: new TelegramDurablePoller({
            api: api as never,
            key: KEY,
            store,
            handleUpdateThroughFinalDelivery: journaledHandler(journal, handled, handler) as never,
        }),
    };
}

test('an update runs once and the offset advances past it', async () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
    const handled: number[] = [];
    const { store, poller } = pollerFor(database, journal, [updateFor(10)], handled);
    await poller.bootstrap();
    store.bootstrap(KEY, 10);
    await poller.pollOnce();
    assert.deepEqual(handled, [10]);
    assert.equal(store.read(KEY), 11);
    assert.equal(journal.find('telegram', BOT, '10')?.state, 'completed');
});

test('a redelivered update is not handled twice', async () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
    const handled: number[] = [];

    // First process: handles it and completes the journal row.
    const first = pollerFor(database, journal, [updateFor(10)], handled);
    first.store.bootstrap(KEY, 10);
    await first.poller.pollOnce();
    assert.deepEqual(handled, [10]);

    // Restart before the offset reached Telegram, so the same update arrives again.
    // Different poller, different in-memory offset — same database.
    const second = pollerFor(database, journal, [updateFor(10)], handled);
    second.store.bootstrap(KEY, 10);
    await second.poller.pollOnce();
    // The journal, not the offset, is what remembers.
    assert.deepEqual(handled, [10], 'the redelivery must not re-run the handler');
});

test('a handler failure leaves the offset where it was so Telegram redelivers', async () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
    const handled: number[] = [];
    const { store, poller } = pollerFor(database, journal, [updateFor(10)], handled, () => {
        throw new Error('handler exploded');
    });
    store.bootstrap(KEY, 10);
    await assert.rejects(() => poller.pollOnce(), /handler exploded/);
    assert.equal(store.read(KEY), 10, 'a failed update must not advance the frontier');
    assert.deepEqual(handled, []);
    // Back to received, not dead-lettered: the redelivery IS the retry.
    assert.equal(journal.find('telegram', BOT, '10')?.state, 'received');
});

test('an update the journal rejects never reaches the handler or the offset', async () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
    const handled: number[] = [];
    const store = new TelegramUpdateOffsetStore(database);
    const poller = new TelegramDurablePoller({
        api: {
            getUpdates: async (opts: { offset: number }) => (opts.offset === -1 ? [] : [updateFor(10)]),
            deleteWebhook: async () => true,
        } as never,
        key: KEY,
        store,
        handleUpdateThroughFinalDelivery: (async () => {
            throw new Error('ingress journal: append failed');
        }) as never,
    });
    store.bootstrap(KEY, 10);
    await assert.rejects(() => poller.pollOnce(), /append failed/);
    assert.equal(store.read(KEY), 10);
    assert.deepEqual(handled, []);
});

test('ordered updates each commit their own offset', async () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
    const handled: number[] = [];
    const { store, poller } = pollerFor(
        database, journal, [updateFor(12), updateFor(10), updateFor(11)], handled,
    );
    store.bootstrap(KEY, 10);
    await poller.pollOnce();
    assert.deepEqual(handled, [10, 11, 12], 'updates must be handled in id order');
    assert.equal(store.read(KEY), 13);
});

// ─── Envelope extraction from raw update shapes ─────
// The poller sees `Update`, not the grammY `Context` the target builder consumes, so
// these assert that the shapes actually arriving are recognised.

test('a group message update yields a journalable envelope', () => {
    const envelope = telegramInboundEnvelope({
        botUserId: BOT,
        updateId: 10,
        chatId: -100999,
        fromId: 42,
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
        now: () => 1,
    });
    assert.equal(envelope?.conversationKey, 'telegram:-100999');
    assert.equal(envelope?.actorId, '42');
    assert.equal(envelope?.ackPolicy, 'after-final-delivery');
});

test('a topic message carries the thread key, and the General topic does not', () => {
    const base = {
        botUserId: BOT, updateId: 11, chatId: -100999, fromId: 42,
        target: { channel: 'telegram' as const, targetKind: 'channel' as const, peerKind: 'group' as const, targetId: '-100999' },
        now: () => 1,
    };
    const topic = telegramInboundEnvelope({ ...base, isTopicMessage: true, messageThreadId: 7 });
    assert.equal(topic?.threadKey, '7');
    // Topic 1 is the forum's General topic — the chat itself, not a distinct thread.
    const general = telegramInboundEnvelope({ ...base, isTopicMessage: true, messageThreadId: 1 });
    assert.equal(general?.threadKey, undefined);
});

test('a missing bot identity produces no envelope at all', () => {
    // The transport refuses to poll without getMe, so this is a contract violation
    // rather than a runtime condition — but it must not fabricate an account id.
    const envelope = telegramInboundEnvelope({
        botUserId: null,
        updateId: 10, chatId: -100999, fromId: 42,
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
        now: () => 1,
    });
    assert.equal(envelope, null);
});

test('a numeric update id becomes the same journal key as its string form', () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
    const numeric = telegramInboundEnvelope({
        botUserId: BOT, updateId: 12345, chatId: -1, fromId: 42,
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-1' },
        now: () => 1,
    })!;
    const stringly = telegramInboundEnvelope({
        botUserId: BOT, updateId: '12345', chatId: -1, fromId: 42,
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-1' },
        now: () => 1,
    })!;
    assert.equal(numeric.eventId, stringly.eventId);
    assert.equal(journal.append(numeric, 'd').appended, true);
    // Bound raw, 12345 would land in the TEXT key as "12345.0" and this would be a
    // second row — one logical update handled twice, with nothing to show for it.
    assert.equal(journal.append(stringly, 'd').appended, false);
});

test('an update left mid-flight by a crash is retried, not skipped', async () => {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot' });
    const handled: number[] = [];

    // A crash between markProcessing and markCompleted leaves the row in `processing`.
    // The offset never advanced, so Telegram redelivers, and that redelivery is the
    // only chance this message has left. Treating it as a duplicate would drop it
    // while advancing the offset past it, which is silent loss.
    journal.append(envelopeFor(10), 'digest-10');
    journal.markProcessing('telegram', BOT, '10');
    assert.equal(journal.find('telegram', BOT, '10')?.state, 'processing');

    const { store, poller } = pollerFor(database, journal, [updateFor(10)], handled);
    store.bootstrap(KEY, 10);
    await poller.pollOnce();

    assert.deepEqual(handled, [10], 'a half-processed update must run again, not be dropped');
    assert.equal(journal.find('telegram', BOT, '10')?.state, 'completed');
    assert.equal(store.read(KEY), 11);
});
