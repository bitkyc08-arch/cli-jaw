// CLI subprocess surface for jaw messaging ingress (M3e).
//
// The journal tests already cover requestReplay. These cover the process
// boundary: --reason, invalid duration, empty list, and the audit file that
// only exists after a successful replay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { IngressJournal } from '../../src/messaging/durable-ingress.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

const projectRoot = join(import.meta.dirname, '../..');

function run(home: string, args: string[]): { stdout: string; stderr: string; status: number } {
    try {
        const stdout = execFileSync(process.execPath, [
            '--import', 'tsx',
            'bin/cli-jaw.ts', '--home', home,
            'messaging', ...args,
        ], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { stdout, stderr: '', status: 0 };
    } catch (error) {
        const err = error as { stdout?: string; stderr?: string; status?: number };
        return {
            stdout: String(err.stdout ?? ''),
            stderr: String(err.stderr ?? ''),
            status: typeof err.status === 'number' ? err.status : 1,
        };
    }
}

function envelope(): InboundEnvelope {
    return {
        channel: 'telegram',
        accountId: 'A1',
        eventId: 'e1',
        conversationKey: 'telegram:C1',
        actorId: 'U1',
        receivedAt: 1_700_000_000_000,
        ackPolicy: 'after-final-delivery',
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: 'C1' },
    };
}

function seedDeadLetter(home: string): void {
    const database = new Database(join(home, 'jaw.db'));
    database.pragma('foreign_keys = ON');
    const journal = new IngressJournal(database, { now: () => 1_700_000_000_000, bootId: 'boot' });
    journal.append(envelope(), 'd', '{}');
    journal.markProcessing('telegram', 'A1', 'e1');
    journal.markDeadLetter('telegram', 'A1', 'e1', 'boom');
    database.close();
}

function readAudit(home: string): Array<Record<string, unknown>> {
    try {
        return readFileSync(join(home, 'messaging-ingress-audit.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

test('empty journal lists without crashing', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-msg-empty-'));
    try {
        const result = run(home, ['ingress', 'list']);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /no matching events/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('replay without --reason exits 1 and does not write audit', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-msg-reason-'));
    try {
        seedDeadLetter(home);
        const result = run(home, ['ingress', 'replay', 'telegram', 'A1', 'e1']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /--reason is required/);
        assert.equal(readAudit(home).length, 0);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('invalid --older-than exits 1 instead of throwing', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-msg-dur-'));
    try {
        const result = run(home, ['ingress', 'list', '--older-than', 'nope']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /invalid duration/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('dead-letter replay marks received and appends audit jsonl', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-msg-replay-'));
    try {
        seedDeadLetter(home);
        const result = run(home, ['ingress', 'replay', 'telegram', 'A1', 'e1', '--reason', 'operator retry']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /marked received/);
        assert.doesNotMatch(result.stdout, /queued for replay/);
        const rows = readAudit(home);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.action, 'replay');
        assert.equal(rows[0]?.priorState, 'dead_letter');
        assert.equal(rows[0]?.newState, 'received');
        assert.equal(rows[0]?.reason, 'operator retry');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
