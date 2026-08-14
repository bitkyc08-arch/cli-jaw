// Outbound attempt outbox (M3g).
//
// reserve-before-send means the row exists before the vendor call. ambiguous is
// terminal for the automatic path — nothing re-sends it, because re-sending is
// exactly the duplicate the state exists to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
    IngressJournal,
    __resetChildRetentionPredicatesForTests,
} from '../../src/messaging/durable-ingress.ts';
import {
    OutboundOutbox,
    initOutboundOutbox,
    getOutboundOutbox,
    __resetOutboundOutboxForTests,
} from '../../src/messaging/outbound-outbox.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

function envelope(): InboundEnvelope {
    return {
        channel: 'telegram',
        accountId: '777',
        eventId: '12345',
        conversationKey: 'telegram:-100999',
        actorId: '42',
        receivedAt: 1_700_000_000_000,
        ackPolicy: 'after-final-delivery',
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
    };
}

function seeded(now = () => 1_000): { database: Database.Database; journal: IngressJournal } {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    const journal = new IngressJournal(database, { now, bootId: 'boot-1' });
    journal.append(envelope(), 'digest-1', '{}');
    return { database, journal };
}

const FIELDS = {
    channel: 'telegram' as const,
    accountId: '777',
    eventId: '12345',
    effectName: 'reply:text',
    targetKey: 'telegram:-100999',
    idempotencyKey: 'idem-1',
    payloadDigest: 'abc123',
};

test.beforeEach(() => {
    __resetChildRetentionPredicatesForTests();
    __resetOutboundOutboxForTests();
});

test.afterEach(() => {
    __resetChildRetentionPredicatesForTests();
    __resetOutboundOutboxForTests();
});

test('reserve creates a pending row before the vendor call', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const outcome = outbox.reserve(FIELDS);
    assert.equal(outcome.reserved, true);
    assert.equal(outcome.record.state, 'pending');
    assert.equal(outcome.record.idempotencyKey, 'idem-1');
    assert.equal(outcome.record.attemptCount, 0);
});

test('duplicate idempotency key returns the existing row instead of a second attempt', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const first = outbox.reserve(FIELDS);
    assert.equal(first.reserved, true);
    const again = outbox.reserve(FIELDS);
    assert.equal(again.reserved, false);
    assert.equal(again.reserved === false && again.reason, 'idempotency_hit');
    assert.equal(again.record.id, first.record.id);
    const rows = database.prepare('SELECT COUNT(*) AS n FROM outbound_attempts').get() as { n: number };
    assert.equal(rows.n, 1);
});

test('pending -> sending -> sent is the happy path', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const { record } = outbox.reserve(FIELDS) as { record: { id: string } };
    assert.equal(outbox.markSending(record.id), true);
    assert.equal(outbox.find(record.id)?.state, 'sending');
    assert.equal(outbox.find(record.id)?.attemptCount, 1);
    assert.equal(outbox.markSent(record.id, 'msg-42'), true);
    assert.equal(outbox.find(record.id)?.state, 'sent');
    assert.equal(outbox.find(record.id)?.platformReceipt, 'msg-42');
});

test('pending -> definitive_failed is a failure before dispatch', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const { record } = outbox.reserve(FIELDS) as { record: { id: string } };
    assert.equal(outbox.markDefinitiveFailed(record.id, 'bad payload'), true);
    assert.equal(outbox.find(record.id)?.state, 'definitive_failed');
});

test('sending -> ambiguous is the only path to ambiguous', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const { record } = outbox.reserve(FIELDS) as { record: { id: string } };

    // pending -> ambiguous must fail: nothing was dispatched
    assert.equal(outbox.markAmbiguous(record.id, 'timeout'), false);
    assert.equal(outbox.find(record.id)?.state, 'pending');

    assert.equal(outbox.markSending(record.id), true);
    assert.equal(outbox.markAmbiguous(record.id, 'timeout'), true);
    assert.equal(outbox.find(record.id)?.state, 'ambiguous');
});

test('ambiguous is terminal: no transition out of it', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const { record } = outbox.reserve(FIELDS) as { record: { id: string } };
    outbox.markSending(record.id);
    outbox.markAmbiguous(record.id, 'timeout');

    assert.equal(outbox.markSending(record.id), false);
    assert.equal(outbox.markSent(record.id), false);
    assert.equal(outbox.markDefinitiveFailed(record.id, 'x'), false);
    assert.equal(outbox.find(record.id)?.state, 'ambiguous');
});

test('sent is terminal: no transition out of it', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const { record } = outbox.reserve(FIELDS) as { record: { id: string } };
    outbox.markSending(record.id);
    outbox.markSent(record.id, 'msg-1');

    assert.equal(outbox.markSending(record.id), false);
    assert.equal(outbox.markAmbiguous(record.id, 'x'), false);
    assert.equal(outbox.find(record.id)?.state, 'sent');
});

test('countAmbiguous tracks only ambiguous rows', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    assert.equal(outbox.countAmbiguous(), 0);

    const a1 = outbox.reserve({ ...FIELDS, idempotencyKey: 'k1' });
    outbox.markSending((a1 as { record: { id: string } }).record.id);
    outbox.markAmbiguous((a1 as { record: { id: string } }).record.id, 'timeout');
    assert.equal(outbox.countAmbiguous(), 1);

    const a2 = outbox.reserve({ ...FIELDS, idempotencyKey: 'k2' });
    outbox.markSending((a2 as { record: { id: string } }).record.id);
    outbox.markSent((a2 as { record: { id: string } }).record.id, 'ok');
    assert.equal(outbox.countAmbiguous(), 1);
});

test('an ambiguous attempt blocks the parent sweep', () => {
    const { database, journal } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const reserved = outbox.reserve(FIELDS);
    const id = (reserved as { record: { id: string } }).record.id;
    outbox.markSending(id);
    outbox.markAmbiguous(id, 'timeout');

    journal.markProcessing('telegram', '777', '12345');
    journal.markCompleted('telegram', '777', '12345');

    const far = 1_700_000_000_000 + 90 * 24 * 60 * 60 * 1_000;
    const sweeper = new IngressJournal(database, { now: () => far, bootId: 'boot-2' });
    assert.equal(sweeper.sweepExpiredTombstones(), 0, 'ambiguous must block the sweep');
});

test('a sent attempt does not block the parent sweep', () => {
    const { database, journal } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    const reserved = outbox.reserve(FIELDS);
    const id = (reserved as { record: { id: string } }).record.id;
    outbox.markSending(id);
    outbox.markSent(id, 'msg-1');

    journal.markProcessing('telegram', '777', '12345');
    journal.markCompleted('telegram', '777', '12345');

    const far = 1_700_000_000_000 + 90 * 24 * 60 * 60 * 1_000;
    const sweeper = new IngressJournal(database, { now: () => far, bootId: 'boot-2' });
    assert.equal(sweeper.sweepExpiredTombstones(), 1, 'sent should release the parent');
});

test('FK refuses an orphan attempt', () => {
    const { database } = seeded();
    const outbox = new OutboundOutbox(database, { now: () => 1_000 });
    assert.throws(
        () => outbox.reserve({ ...FIELDS, eventId: 'no-such-event' }),
        /FOREIGN KEY/i,
    );
});

test('init exposes the outbox and reset clears it', () => {
    const { database } = seeded();
    assert.equal(getOutboundOutbox(), null);
    const outbox = initOutboundOutbox(database, { now: () => 1_000 });
    assert.equal(getOutboundOutbox(), outbox);
    __resetOutboundOutboxForTests();
    assert.equal(getOutboundOutbox(), null);
});
