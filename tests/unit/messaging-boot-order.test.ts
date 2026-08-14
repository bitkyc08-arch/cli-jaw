// A cli-jaw upgrade went dark on a real Windows host: 2.4.0 booted, reported
// ok:true, and answered nothing on Slack. The journal's retention guard threw
// during startup and killed boot before any transport initialized.
//
// The guard asserts that every table with a foreign key into ingress_events has
// registered a retention predicate, and a predicate is only registered by its
// owning store's CONSTRUCTOR. server.ts built the journal first, so:
//
//   fresh database  -> child tables do not exist yet -> assert finds nothing -> passes
//   second boot     -> child tables are on disk, registry is empty -> THROWS
//
// So the bug could only appear on a host that had already run once. Every test
// and every fresh install passed. This pins the restart shape specifically.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
    initIngressJournal,
    __resetChildRetentionPredicatesForTests,
} from '../../src/messaging/durable-ingress.ts';
import { initEffectClaimStore } from '../../src/messaging/effect-once.ts';
import { initOutboundOutbox } from '../../src/messaging/outbound-outbox.ts';

/** The order server.ts boots these in. Children first, journal last. */
function bootMessagingStores(db: Database.Database): void {
    initEffectClaimStore(db);
    initOutboundOutbox(db);
    initIngressJournal(db);
}

test('a second boot against an existing database does not throw', () => {
    const db = new Database(':memory:');
    bootMessagingStores(db);

    // A new process starts with an empty predicate registry but inherits the
    // tables from the previous run. This is the exact state of every upgraded
    // host, and it used to abort startup.
    __resetChildRetentionPredicatesForTests();
    assert.doesNotThrow(() => bootMessagingStores(db), 'restart boot must survive');
});

test('the guard still fires when a child really did not announce itself', () => {
    const db = new Database(':memory:');
    bootMessagingStores(db);
    __resetChildRetentionPredicatesForTests();

    // Only the outbox registers. effect_claims exists on disk with a foreign key
    // into the journal and no predicate — precisely what the guard is for.
    initOutboundOutbox(db);
    assert.throws(
        () => initIngressJournal(db),
        /effect_claims.*without a registered retention predicate/s,
        'the guard must not be weakened into silence',
    );
});

