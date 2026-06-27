import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 104.3 cross-process watcher lock. Uses a fresh temp CLI_JAW_HOME so the lock dir lands
// under an isolated home.
test('BWAI-WLOCK-001: acquire is exclusive, releasable, and re-acquirable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cjwl-'));
    process.env.CLI_JAW_HOME = home;
    const lock = await import('../../src/browser/web-ai/watcher-lock.js');

    const l1 = lock.acquireWatcherSessionLock('webai_1');
    assert.ok(l1.lockPath.startsWith(home));

    // a second live acquire for the same session is rejected (this PID is alive + fresh)
    assert.throws(() => lock.acquireWatcherSessionLock('webai_1'), /already running/);

    // a different session is independent
    const other = lock.acquireWatcherSessionLock('webai_2');
    other.release();

    // after release, the session can be re-acquired
    l1.release();
    const l2 = lock.acquireWatcherSessionLock('webai_1');
    assert.ok(l2.lockPath);
    l2.release();
});

test('BWAI-WLOCK-002: staleness — no metadata / dead PID / stale heartbeat are stale', async () => {
    process.env.CLI_JAW_HOME = mkdtempSync(join(tmpdir(), 'cjwl-'));
    const lock = await import('../../src/browser/web-ai/watcher-lock.js');

    assert.equal(lock.isWatcherLockStale(null, 1000), true);
    assert.equal(lock.isWatcherLockStale({ sessionId: 's', pid: 2147483646 }, 1000), true, 'dead PID');
    assert.equal(
        lock.isWatcherLockStale({ sessionId: 's', pid: process.pid, heartbeatAt: new Date().toISOString() }, 1000),
        false,
        'alive + fresh heartbeat',
    );
    assert.equal(
        lock.isWatcherLockStale({ sessionId: 's', pid: process.pid, heartbeatAt: new Date(Date.now() - 10_000).toISOString() }, 1000),
        true,
        'alive but stale heartbeat',
    );
});
