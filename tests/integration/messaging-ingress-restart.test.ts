// File-backed restart (M5d).
//
// The unit suites reopen an in-memory Database handle. That is not a process
// death. This file closes the connection and opens the same jaw.db path so a
// completed row stays refused and a mid-flight row keeps its trace_id.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { admitIngress, IngressJournal } from '../../src/messaging/durable-ingress.ts';
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

function openJournal(home: string, bootId: string): { database: Database.Database; journal: IngressJournal } {
    const database = new Database(join(home, 'jaw.db'));
    database.pragma('foreign_keys = ON');
    return { database, journal: new IngressJournal(database, { now: () => 1, bootId }) };
}

test('a completed event is already_handled after the file is reopened', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-ingress-restart-'));
    try {
        const first = openJournal(home, 'boot-1');
        const admitted = admitIngress(first.journal, envelope(), 'd');
        assert.equal(admitted.admit, true);
        first.journal.markCompleted('telegram', 'A1', 'e1');
        const traceId = first.journal.find('telegram', 'A1', 'e1')?.traceId;
        first.database.close();

        const second = openJournal(home, 'boot-2');
        const again = admitIngress(second.journal, envelope(), 'd');
        assert.equal(again.admit, false);
        assert.equal(again.admit === false && again.reason, 'already_handled');
        assert.equal(second.journal.find('telegram', 'A1', 'e1')?.traceId, traceId);
        second.database.close();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('a mid-flight event is re-admitted with the stored trace_id after reopen', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-ingress-midflight-'));
    try {
        const first = openJournal(home, 'boot-1');
        const admitted = admitIngress(first.journal, envelope('e2'), 'd');
        assert.equal(admitted.admit, true);
        const stored = first.journal.find('telegram', 'A1', 'e2');
        assert.equal(stored?.state, 'processing');
        const traceId = stored?.traceId;
        first.database.close();

        const second = openJournal(home, 'boot-2');
        const again = admitIngress(second.journal, envelope('e2'), 'd');
        assert.equal(again.admit, true);
        const row = second.journal.find('telegram', 'A1', 'e2');
        assert.equal(row?.traceId, traceId);
        assert.equal(row?.state, 'processing');
        second.database.close();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('a different generation after reopen is stale and not claimed', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-ingress-stale-'));
    try {
        const first = openJournal(home, 'boot-1');
        admitIngress(first.journal, envelope('e3'), 'd', '{}', 2);
        first.database.close();

        const second = openJournal(home, 'boot-2');
        const stale = admitIngress(second.journal, envelope('e3'), 'd', '{}', 3);
        assert.equal(stale.admit, false);
        assert.equal(stale.admit === false && stale.reason, 'stale_generation');
        assert.equal(second.journal.find('telegram', 'A1', 'e3')?.state, 'processing');
        assert.equal(second.journal.find('telegram', 'A1', 'e3')?.sessionGeneration, 2);
        second.database.close();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
