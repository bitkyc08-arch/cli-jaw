import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, getSessionBucket, upsertSessionBucket } from '../../src/core/db.ts';
import { autoCompactRefresh } from '../../src/core/compact.ts';

// 072 §1.2b — a `local:` scope shares the default session's bucket and singleton row on
// every runtime whose bucket key has no scope in it. A compact triggered by that scope
// must not throw away the conversation the default session is still using.

function defaultSessionId(): string | null {
    const row = db.prepare("SELECT session_id FROM session WHERE id = 'default'").get() as { session_id?: string } | undefined;
    return row?.session_id ?? null;
}

function seedSharedState(): void {
    upsertSessionBucket.run('claude', 'vendor-thread-of-default', 'default', null, 0);
    db.prepare("UPDATE session SET session_id = 'vendor-thread-of-default', active_cli = 'claude' WHERE id = 'default'").run();
}

afterEach(() => {
    db.prepare("DELETE FROM session_buckets WHERE bucket = 'claude'").run();
    db.prepare("UPDATE session SET session_id = NULL WHERE id = 'default'").run();
});

test('a compact in a local scope leaves the shared bucket and session row alone', async () => {
    seedSharedState();

    await autoCompactRefresh({
        workDir: '/tmp', instructions: '', cli: 'claude', model: 'default',
        scopeKey: 'local:sess-2',
    });

    const bucket = getSessionBucket.get('claude') as { session_id?: string } | undefined;
    assert.equal(bucket?.session_id, 'vendor-thread-of-default', 'the shared bucket must survive');
    assert.equal(defaultSessionId(), 'vendor-thread-of-default', 'the shared session row must survive');
});

test('a compact in the default scope still clears the shared state', async () => {
    seedSharedState();

    await autoCompactRefresh({
        workDir: '/tmp', instructions: '', cli: 'claude', model: 'default',
        scopeKey: 'default',
    });

    assert.equal(getSessionBucket.get('claude'), undefined, 'its own bucket must be cleared');
    assert.equal(defaultSessionId(), null, 'its own session row must be cleared');
});

// codex-app multiplex puts the scope inside the bucket key, so it owns real per-scope
// state and a compact there is a normal refresh of that scope's own bucket.
test('a local scope with its own scoped bucket still compacts that bucket', async () => {
    seedSharedState();
    upsertSessionBucket.run('codex-app:local:sess-2', 'thread-2', 'gpt-5.5', null, 0);

    await autoCompactRefresh({
        workDir: '/tmp', instructions: '', cli: 'codex-app', model: 'gpt-5.5',
        scopeKey: 'local:sess-2', sessionBucket: 'codex-app:local:sess-2',
    });

    assert.equal(getSessionBucket.get('codex-app:local:sess-2'), undefined, 'its own scoped bucket is cleared');
    const shared = getSessionBucket.get('claude') as { session_id?: string } | undefined;
    assert.equal(shared?.session_id, 'vendor-thread-of-default', 'another runtime bucket is untouched');
});
