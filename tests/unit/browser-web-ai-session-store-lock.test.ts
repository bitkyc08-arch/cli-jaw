import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isStaleLock, isSessionActive } from '../../src/browser/web-ai/session-store.js';

const mk = (o: object): Parameters<typeof isSessionActive>[0] => o as unknown as Parameters<typeof isSessionActive>[0];

// 104.1: the session store lock staleness now uses PID-liveness, so a crashed holder's lock
// is reclaimed immediately instead of being honoured until the TTL expires.
test('BWAI-SLOCK-001: dead-PID lock is stale immediately; live+recent is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cjsl-'));
    const p = join(dir, 'lock');

    // dead PID + recent acquiredAt → stale (PID-liveness wins)
    writeFileSync(p, JSON.stringify({ pid: 2147483646, acquiredAt: new Date().toISOString() }));
    assert.equal(isStaleLock(p), true);

    // live PID (this process) + recent → NOT stale
    writeFileSync(p, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    assert.equal(isStaleLock(p), false);

    // no PID + old timestamp → stale by age
    writeFileSync(p, JSON.stringify({ acquiredAt: new Date(Date.now() - 60 * 60_000).toISOString() }));
    assert.equal(isStaleLock(p), true);

    // missing/garbage file → stale
    assert.equal(isStaleLock(join(dir, 'nope')), true);
    writeFileSync(p, 'not json');
    assert.equal(isStaleLock(p), true);
});

test('BWAI-SLOCK-002: isSessionActive excludes non-active status and expired deadlines', () => {
    const now = Date.now();
    // active status, within deadline
    assert.equal(isSessionActive(mk({ status: 'sent', createdAt: new Date(now).toISOString(), timeoutMs: 60_000 }), now), true);
    // active status but expired (createdAt + timeoutMs < now)
    assert.equal(isSessionActive(mk({ status: 'sent', createdAt: new Date(now - 120_000).toISOString(), timeoutMs: 60_000 }), now), false);
    // non-active status
    assert.equal(isSessionActive(mk({ status: 'complete', createdAt: new Date(now).toISOString(), timeoutMs: 60_000 }), now), false);
    // no deadline info → active by status alone
    assert.equal(isSessionActive(mk({ status: 'sent' }), now), true);
    // explicit deadlineAt in the past → inactive
    assert.equal(isSessionActive(mk({ status: 'sent', deadlineAt: new Date(now - 1000).toISOString() }), now), false);
});
