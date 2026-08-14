import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { IngressJournal, admitIngress } from '../../src/messaging/durable-ingress.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

function envelope(eventId = 'e1'): InboundEnvelope {
    return {
        channel: 'telegram',
        accountId: 'A1',
        eventId,
        conversationKey: 'telegram:C1',
        actorId: 'U1',
        receivedAt: 1_700_000_000_000,
        ackPolicy: 'after-final-delivery',
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: 'C1' },
    };
}

function journal() {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    return new IngressJournal(database, { now: () => 1_700_000_000_000, bootId: 'boot' });
}

test('fresh and upgraded journals expose session_generation 0', () => {
    const j = journal();
    const row = j.append(envelope(), 'd', '{}').record;
    assert.equal(row.sessionGeneration, 0);

    const legacy = new Database(':memory:');
    legacy.exec(`
        CREATE TABLE ingress_events (
            channel TEXT NOT NULL, account_id TEXT NOT NULL, event_id TEXT NOT NULL,
            conversation_key TEXT NOT NULL, thread_key TEXT, actor_id TEXT NOT NULL,
            target_json TEXT NOT NULL, ack_policy TEXT NOT NULL, trace_id TEXT NOT NULL,
            payload_digest TEXT NOT NULL, payload_json TEXT,
            state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
            received_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
            next_attempt_at INTEGER, last_error TEXT, tombstone_until INTEGER,
            PRIMARY KEY (channel, account_id, event_id)
        );
    `);
    const upgraded = new IngressJournal(legacy, { now: () => 1, bootId: 'b' });
    const cols = legacy.prepare('PRAGMA table_info(ingress_events)').all() as Array<{ name: string }>;
    assert.ok(cols.some(c => c.name === 'session_generation'));
    const stamped = upgraded.append(envelope('e2'), 'd', undefined, 4).record;
    assert.equal(stamped.sessionGeneration, 4);
});

test('same-generation redelivery of a mid-flight row is admitted', () => {
    const j = journal();
    const first = admitIngress(j, envelope(), 'd', '{}', 2);
    assert.equal(first.admit, true);
    const again = admitIngress(j, envelope(), 'd', '{}', 2);
    assert.equal(again.admit, true);
});

test('different-generation redelivery is refused and not claimed', () => {
    const j = journal();
    admitIngress(j, envelope(), 'd', '{}', 2);
    const stale = admitIngress(j, envelope(), 'd', '{}', 3);
    assert.equal(stale.admit, false);
    assert.equal(stale.admit === false && stale.reason, 'stale_generation');
    assert.equal(j.find('telegram', 'A1', 'e1')?.state, 'processing');
    assert.equal(j.find('telegram', 'A1', 'e1')?.sessionGeneration, 2);
});

test('completed still wins over generation', () => {
    const j = journal();
    admitIngress(j, envelope(), 'd', '{}', 1);
    j.markCompleted('telegram', 'A1', 'e1');
    const again = admitIngress(j, envelope(), 'd', '{}', 9);
    assert.equal(again.admit, false);
    assert.equal(again.admit === false && again.reason, 'already_handled');
});
