// Operator surface for the ingress journal (M3e).
//
// Three channels write this table and, until now, nothing could read it: a dead letter
// was invisible and a stuck row had no recovery path. These cover the refusals more
// closely than the happy path, because a replay re-runs somebody's message and the
// wrong refusal is what turns a recovery tool into a second incident.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { IngressJournal } from '../../src/messaging/durable-ingress.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

function freshDb(): Database.Database {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    return database;
}

function envelope(eventId: string, channel: 'telegram' | 'slack' = 'telegram'): InboundEnvelope {
    return {
        channel,
        accountId: 'A1',
        eventId,
        conversationKey: channel + ':C1',
        actorId: 'U1',
        receivedAt: 1_700_000_000_000,
        ackPolicy: channel === 'slack' ? 'after-durable-append' : 'after-final-delivery',
        target: channel === 'slack'
            ? { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1' }
            : { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: 'C1' },
    };
}

function seeded(clock = { now: 1_700_000_000_000 }) {
    const database = freshDb();
    const journal = new IngressJournal(database, { now: () => clock.now, bootId: 'boot' });
    return { database, journal, clock };
}

test('an empty journal lists and counts without failing', () => {
    const { journal } = seeded();
    assert.deepEqual(journal.list(), []);
    assert.deepEqual(journal.counts(), { received: 0, processing: 0, completed: 0, dead_letter: 0 });
});

test('list filters by channel and by state', () => {
    const { journal } = seeded();
    journal.append(envelope('t1'), 'd');
    journal.append(envelope('s1', 'slack'), 'd');
    journal.markProcessing('slack', 'A1', 's1');
    journal.markDeadLetter('slack', 'A1', 's1', 'boom');

    assert.deepEqual(journal.list({ channel: 'slack' }).map(r => r.eventId), ['s1']);
    assert.deepEqual(journal.list({ state: 'dead_letter' }).map(r => r.eventId), ['s1']);
    assert.deepEqual(journal.list({ state: 'received' }).map(r => r.eventId), ['t1']);
    assert.deepEqual(journal.counts(), { received: 1, processing: 0, completed: 0, dead_letter: 1 });
});

test('list filters by age', () => {
    const clock = { now: 1_700_000_000_000 };
    const { journal } = seeded(clock);
    journal.append(envelope('old'), 'd');
    clock.now += 2 * 60 * 60 * 1000;
    journal.append({ ...envelope('new'), receivedAt: clock.now }, 'd');
    // Only the row that has been waiting longer than an hour.
    assert.deepEqual(journal.list({ olderThanMs: 60 * 60 * 1000 }).map(r => r.eventId), ['old']);
});

test('a dead letter can be replayed and returns to received', () => {
    const { journal } = seeded();
    journal.append(envelope('e1'), 'd', '{}');
    journal.markProcessing('telegram', 'A1', 'e1');
    journal.markDeadLetter('telegram', 'A1', 'e1', 'boom');

    const outcome = journal.requestReplay('telegram', 'A1', 'e1');
    assert.equal(outcome.replayed, true);
    assert.equal(journal.find('telegram', 'A1', 'e1')?.state, 'received');
    // The error is cleared so the next failure is not confused with the last one.
    assert.equal(journal.find('telegram', 'A1', 'e1')?.lastError, null);
});

test('a completed event is refused unless forced', () => {
    const { journal } = seeded();
    journal.append(envelope('e2'), 'd', '{}');
    journal.markProcessing('telegram', 'A1', 'e2');
    journal.markCompleted('telegram', 'A1', 'e2');

    const refused = journal.requestReplay('telegram', 'A1', 'e2');
    assert.equal(refused.replayed, false);
    assert.equal(refused.replayed === false && refused.reason, 'already_completed');
    assert.equal(journal.find('telegram', 'A1', 'e2')?.state, 'completed');
});

test('forcing a completed event still fails once its payload is gone', () => {
    const { journal } = seeded();
    journal.append(envelope('e3'), 'd', '{}');
    journal.markProcessing('telegram', 'A1', 'e3');
    journal.markCompleted('telegram', 'A1', 'e3');

    // Completion drops the payload, so there is literally nothing left to replay.
    // Saying so beats pretending the replay was queued.
    const forced = journal.requestReplay('telegram', 'A1', 'e3', { force: true });
    assert.equal(forced.replayed, false);
    assert.equal(forced.replayed === false && forced.reason, 'payload_discarded');
});

test('an in-flight event is refused rather than yanked out from under its handler', () => {
    const { journal } = seeded();
    journal.append(envelope('e4'), 'd');
    journal.markProcessing('telegram', 'A1', 'e4');

    const refused = journal.requestReplay('telegram', 'A1', 'e4');
    assert.equal(refused.replayed, false);
    assert.equal(refused.replayed === false && refused.reason, 'in_flight');
});

test('replaying an unknown event reports not_found instead of inventing a row', () => {
    const { journal } = seeded();
    const refused = journal.requestReplay('telegram', 'A1', 'nope');
    assert.equal(refused.replayed, false);
    assert.equal(refused.replayed === false && refused.reason, 'not_found');
    assert.deepEqual(journal.list(), []);
});

test('a replayed dead letter can be handled again', () => {
    const { journal } = seeded();
    journal.append(envelope('e5'), 'd', '{}');
    journal.markProcessing('telegram', 'A1', 'e5');
    journal.markDeadLetter('telegram', 'A1', 'e5', 'boom');
    journal.requestReplay('telegram', 'A1', 'e5');

    // The point of a replay is that the next run actually claims it.
    assert.equal(journal.markProcessing('telegram', 'A1', 'e5'), true);
    assert.equal(journal.markCompleted('telegram', 'A1', 'e5'), true);
    assert.equal(journal.find('telegram', 'A1', 'e5')?.attemptCount, 2);
});
test('requestReplay refuses a row that became processing after the read', () => {
    const { journal } = seeded();
    journal.append(envelope('race'), 'd', '{}');
    journal.markProcessing('telegram', 'A1', 'race');
    journal.markDeadLetter('telegram', 'A1', 'race', 'boom');

    const originalFind = journal.find.bind(journal);
    let reads = 0;
    journal.find = ((channel, accountId, eventId) => {
        const row = originalFind(channel, accountId, eventId);
        reads += 1;
        // After the classification read, another handler claims the row.
        // The CAS UPDATE must then lose rather than reset processing.
        if (reads === 1) journal.markProcessing(channel, accountId, eventId);
        return row;
    }) as typeof journal.find;

    const refused = journal.requestReplay('telegram', 'A1', 'race');
    assert.equal(refused.replayed, false);
    assert.equal(refused.replayed === false && refused.reason, 'in_flight');
    assert.equal(originalFind('telegram', 'A1', 'race')?.state, 'processing');
});
