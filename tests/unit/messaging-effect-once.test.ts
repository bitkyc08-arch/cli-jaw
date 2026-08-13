// Effect-once claim FSM (M3f).
//
// The point of every case here is the same one: a lease running out is not evidence
// that the effect did not happen. Expiry may hand the row to a new owner; it may not
// hand it back to the effect body.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
    IngressJournal,
    __resetChildRetentionPredicatesForTests,
    assertChildRetentionPredicatesRegistered,
} from '../../src/messaging/durable-ingress.ts';
import {
    EffectClaimStore,
    LOCAL_EFFECT_LEASE_MS,
    REMOTE_EFFECT_LEASE_MS,
    __resetEffectClaimStoreForTests,
    getEffectClaimStore,
    initEffectClaimStore,
} from '../../src/messaging/effect-once.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

const KEY = {
    channel: 'telegram' as const,
    accountId: '777',
    eventId: '12345',
    effectName: 'session.reset:s1:2',
};

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

/** A parent row must exist: the FK is what keeps a claim from outliving its event. */
function seeded(now = () => 1_000): { database: Database.Database; journal: IngressJournal } {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    const journal = new IngressJournal(database, { now, bootId: 'boot-1' });
    journal.append(envelope(), 'digest-1', '{}');
    return { database, journal };
}

test.beforeEach(() => {
    __resetChildRetentionPredicatesForTests();
    __resetEffectClaimStoreForTests();
});

test.afterEach(() => {
    __resetChildRetentionPredicatesForTests();
    __resetEffectClaimStoreForTests();
});

test('a first claim is acquired and lands in claimed with a lease', () => {
    const { database } = seeded();
    const store = new EffectClaimStore(database, { now: () => 1_000, ownerId: 'boot:w1' });
    const outcome = store.claim(KEY);
    assert.equal(outcome.acquired, true);
    assert.equal(outcome.record.state, 'claimed');
    assert.equal(outcome.record.ownerId, 'boot:w1');
    assert.equal(outcome.record.leaseExpiresAt, 1_000 + LOCAL_EFFECT_LEASE_MS);
});

test('a live lease is refused, so a redelivery does not run the effect again', () => {
    const { database } = seeded();
    const first = new EffectClaimStore(database, { now: () => 1_000, ownerId: 'boot:w1' });
    const acquired = first.claim(KEY);
    assert.equal(acquired.acquired, true);

    const second = new EffectClaimStore(database, { now: () => 2_000, ownerId: 'boot:w2' });
    const refused = second.claim(KEY);
    assert.equal(refused.acquired, false);
    assert.equal(refused.acquired === false && refused.reason, 'lease_held');
    assert.equal(refused.record.ownerId, 'boot:w1');
});

test('an expired lease is re-claimed by a new owner with a new token', () => {
    const { database } = seeded();
    const first = new EffectClaimStore(database, { now: () => 1_000, ownerId: 'boot:w1' });
    const original = first.claim(KEY);
    assert.equal(original.acquired, true);
    const originalToken = original.acquired === true ? original.claimToken : '';

    const later = 1_000 + LOCAL_EFFECT_LEASE_MS + 1;
    const second = new EffectClaimStore(database, { now: () => later, ownerId: 'boot:w2' });
    const reclaimed = second.claim(KEY);
    assert.equal(reclaimed.acquired, true);
    assert.notEqual(reclaimed.acquired === true && reclaimed.claimToken, originalToken);
    assert.equal(reclaimed.record.ownerId, 'boot:w2');
    assert.equal(reclaimed.record.state, 'claimed', 'expiry hands over the claim, it does not decide the outcome');
});

test('the dispossessed owner can no longer complete the claim', () => {
    const { database } = seeded();
    const first = new EffectClaimStore(database, { now: () => 1_000, ownerId: 'boot:w1' });
    const original = first.claim(KEY);
    const staleToken = original.acquired === true ? original.claimToken : '';

    const later = 1_000 + LOCAL_EFFECT_LEASE_MS + 1;
    const second = new EffectClaimStore(database, { now: () => later, ownerId: 'boot:w2' });
    second.claim(KEY);

    assert.equal(first.complete(KEY, staleToken), false, 'a stale token must change no rows');
    assert.equal(first.find(KEY)?.state, 'claimed');
});

test('complete, fail, and manual are terminal and refuse a fresh claim', () => {
    for (const settle of ['complete', 'fail', 'manual'] as const) {
        __resetChildRetentionPredicatesForTests();
        const { database } = seeded();
        const store = new EffectClaimStore(database, { now: () => 1_000, ownerId: 'boot:w1' });
        const claimed = store.claim(KEY);
        const token = claimed.acquired === true ? claimed.claimToken : '';
        if (settle === 'complete') assert.equal(store.complete(KEY, token, 'result-digest'), true);
        if (settle === 'fail') assert.equal(store.fail(KEY, token, 'nothing was written'), true);
        if (settle === 'manual') assert.equal(store.holdForManual(KEY, token, 'cannot tell'), true);

        const after = store.find(KEY);
        assert.equal(after?.leaseExpiresAt, null, 'a settled claim must not keep a lease');

        const again = new EffectClaimStore(database, { now: () => 10_000_000, ownerId: 'boot:w2' });
        const refused = again.claim(KEY);
        assert.equal(refused.acquired, false);
        assert.equal(refused.acquired === false && refused.reason, 'terminal');
    }
});

test('a heartbeat extends only the lease this owner and token hold', () => {
    const { database } = seeded();
    let clock = 1_000;
    const store = new EffectClaimStore(database, { now: () => clock, ownerId: 'boot:w1' });
    const claimed = store.claim(KEY, REMOTE_EFFECT_LEASE_MS);
    const token = claimed.acquired === true ? claimed.claimToken : '';

    clock = 1_000 + 40_000;
    assert.equal(store.heartbeat(KEY, token, REMOTE_EFFECT_LEASE_MS), true);
    assert.equal(store.find(KEY)?.leaseExpiresAt, clock + REMOTE_EFFECT_LEASE_MS);
    assert.equal(store.heartbeat(KEY, 'not-the-token'), false);
});

test('an expired claim is listed as a reconciler candidate, not re-run', () => {
    const { database } = seeded();
    const store = new EffectClaimStore(database, { now: () => 1_000, ownerId: 'boot:w1' });
    store.claim(KEY);
    assert.equal(store.listExpired(1_000).length, 0);
    const expired = store.listExpired(1_000 + LOCAL_EFFECT_LEASE_MS + 1);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.state, 'claimed');
});

test('a non-terminal claim blocks its parent sweep and a settled one does not', () => {
    const { database, journal } = seeded();
    const store = new EffectClaimStore(database, { now: () => 1_000, ownerId: 'boot:w1' });
    const claimed = store.claim(KEY);
    const token = claimed.acquired === true ? claimed.claimToken : '';

    journal.markProcessing('telegram', '777', '12345');
    journal.markCompleted('telegram', '777', '12345');

    const far = 1_700_000_000_000 + 90 * 24 * 60 * 60 * 1_000;
    const blocked = new IngressJournal(database, { now: () => far, bootId: 'boot-2' });
    assert.equal(blocked.sweepExpiredTombstones(), 0, 'a live claim must keep its event');

    assert.equal(store.holdForManual(KEY, token, 'operator must decide'), true);
    assert.equal(blocked.sweepExpiredTombstones(), 0, 'manual is unresolved, so it still blocks');

    const store2 = new EffectClaimStore(database, { now: () => far, ownerId: 'boot:w2' });
    database.prepare("UPDATE effect_claims SET state = 'completed' WHERE effect_name = ?").run(KEY.effectName);
    assert.equal(store2.find(KEY)?.state, 'completed');
    assert.equal(blocked.sweepExpiredTombstones(), 1, 'a settled claim releases its parent');
});

test('the retention guard accepts the table once the store registers it', () => {
    const { database } = seeded();
    assert.throws(() => {
        database.exec(`
            CREATE TABLE IF NOT EXISTS effect_claims (
                channel TEXT NOT NULL, account_id TEXT NOT NULL, event_id TEXT NOT NULL,
                effect_name TEXT NOT NULL, claim_token TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL DEFAULT 'claimed', owner_id TEXT, lease_expires_at INTEGER,
                result_digest TEXT, claimed_at INTEGER NOT NULL, completed_at INTEGER, last_error TEXT,
                PRIMARY KEY (channel, account_id, event_id, effect_name),
                FOREIGN KEY (channel, account_id, event_id)
                    REFERENCES ingress_events(channel, account_id, event_id)
            );
        `);
        assertChildRetentionPredicatesRegistered(database);
    }, /retention predicate/);

    new EffectClaimStore(database, { now: () => 1_000 });
    assertChildRetentionPredicatesRegistered(database);
});

test('a claim for an event the journal never saw is refused by the foreign key', () => {
    const { database } = seeded();
    const store = new EffectClaimStore(database, { now: () => 1_000 });
    assert.throws(() => store.claim({ ...KEY, eventId: 'no-such-event' }), /FOREIGN KEY/i);
});

test('init exposes the store and reset clears it', () => {
    const { database } = seeded();
    assert.equal(getEffectClaimStore(), null);
    const store = initEffectClaimStore(database, { now: () => 1_000 });
    assert.equal(getEffectClaimStore(), store);
    __resetEffectClaimStoreForTests();
    assert.equal(getEffectClaimStore(), null);
});
