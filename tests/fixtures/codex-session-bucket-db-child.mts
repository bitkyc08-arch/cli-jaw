import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const home = process.env['CLI_JAW_HOME'];
assert.ok(home && isAbsolute(home) && home.startsWith(tmpdir()) && home !== tmpdir(),
    'fixture requires an isolated absolute temp CLI_JAW_HOME before importing db');

const database = await import('../../src/core/db.ts');

function bucketSessionId(bucket: string): string | undefined {
    const row = database.getSessionBucket.get(bucket) as { session_id?: string } | undefined;
    return row?.session_id;
}

try {
    const insert = database.db.prepare(`
        INSERT INTO session_buckets (
            bucket, session_id, model, resume_key, output_len, memory_snapshot,
            updated_at, last_run_clean, last_run_cwd, last_run_meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
        'codex-app',
        'thread-legacy',
        'gpt-5.5',
        'resume-legacy',
        4321,
        '{"summary":"legacy"}',
        '2026-08-04 12:34:56',
        1,
        '/tmp/legacy-cwd',
        '{"clean":true}',
    );

    database.copySessionBucketIfMissing.run('codex-app:default', 'codex-app');
    const legacy = database.getSessionBucket.get('codex-app') as Record<string, unknown>;
    const copied = database.getSessionBucket.get('codex-app:default') as Record<string, unknown>;
    assert.deepEqual(
        { ...copied, bucket: 'codex-app' },
        legacy,
        'copy must preserve all resume, snapshot, timestamp, and clean-run metadata',
    );

    database.db.prepare(`
        UPDATE session_buckets
        SET session_id = ?, resume_key = ?, memory_snapshot = ?
        WHERE bucket = ?
    `).run('thread-scoped', 'resume-scoped', '{"summary":"scoped"}', 'codex-app:default');
    database.copySessionBucketIfMissing.run('codex-app:default', 'codex-app');
    const preserved = database.getSessionBucket.get('codex-app:default') as Record<string, unknown>;
    assert.equal(preserved["session_id"], 'thread-scoped');
    assert.equal(preserved["resume_key"], 'resume-scoped');
    assert.equal(preserved["memory_snapshot"], '{"summary":"scoped"}');

    database.db.prepare('DELETE FROM session_buckets').run();
    const persistence = await import('../../src/agent/session-persistence.ts');
    persistence.resetSessionOwnershipGenerationForTest();
    const scopeKey = 'scope-a';
    const persistenceOwner = persistence.getSessionOwnershipGeneration(scopeKey);
    const capturedBucket = 'codex-app:scope-a:gpt-5.5:high';
    assert.equal(persistence.persistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'codex-app',
        model: 'gpt-5.5',
        effort: 'high',
        sessionId: 'thread-scoped',
        code: 0,
        codexAppBucket: capturedBucket,
    }), true);
    assert.equal(bucketSessionId(capturedBucket), 'thread-scoped');
    assert.equal(bucketSessionId('codex-app'), undefined,
        'captured bucket writes must not be recomputed into the legacy row');
    // A caller that names no bucket used to fall through to the bare `codex-app` row,
    // which belongs to the default session — so a run in `scope-a` overwrote the thread
    // the default session resumes from. Two pre-shutdown saves did exactly that. The
    // fallback now scopes itself, so a forgotten bucket costs a fresh row, not another
    // session's conversation (073 §2.1).
    assert.equal(persistence.persistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'codex-app',
        model: 'gpt-5.5',
        effort: 'high',
        sessionId: 'thread-unnamed-bucket',
        code: 0,
    }), true);
    assert.equal(bucketSessionId('codex-app'), undefined,
        'a non-default scope must never land on the default session row');
    assert.equal(bucketSessionId('codex-app:scope-a'), 'thread-unnamed-bucket');
    assert.equal(bucketSessionId(capturedBucket), 'thread-scoped');

    // The default scope keeps the bare name, which is what a session created before 073
    // has been resuming from all along.
    assert.equal(persistence.persistMainSession({
        persistenceOwner: persistence.getSessionOwnershipGeneration('default'),
        scopeKey: 'default',
        cli: 'codex-app',
        model: 'gpt-5.5',
        effort: 'high',
        sessionId: 'thread-legacy',
        code: 0,
    }), true);
    assert.equal(bucketSessionId('codex-app'), 'thread-legacy');

    database.db.prepare('DELETE FROM session_buckets').run();
    database.updateSession.run('codex-app', 'singleton-before', 'gpt-5.5', 'auto', '/tmp', 'high');
    database.upsertSessionBucket.run('codex-app', 'legacy-before', 'gpt-5.5', null, 0);
    const singletonBefore = database.getSession() as Record<string, unknown>;
    const legacyBefore = database.getSessionBucket.get('codex-app') as Record<string, unknown>;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        assert.equal(persistence.persistMainSession({
            persistenceOwner: persistence.getSessionOwnershipGeneration(scopeKey),
            scopeKey,
            cli: 'codex-app',
            model: 'gpt-5.5',
            effort: 'high',
            sessionId: 'must-not-persist',
            code: 0,
            codexAppBucket: '',
        }), false);
    } finally {
        console.warn = originalWarn;
    }
    assert.ok(warnings.length > 0, 'invalid bucket rejection must emit a diagnostic warning');
    assert.deepEqual(database.getSession(), singletonBefore, 'singleton row must stay unchanged');
    assert.deepEqual(database.getSessionBucket.get('codex-app'), legacyBefore,
        'legacy bucket row must stay unchanged');
    assert.equal(bucketSessionId(''), undefined, 'invalid bucket row must not be created');

    database.db.prepare('DELETE FROM session_buckets').run();
    database.upsertSessionBucket.run('codex-app', 'thread-legacy', 'gpt-5.5', null, 0);
    database.upsertSessionBucket.run(capturedBucket, 'thread-scoped', 'gpt-5.5', null, 0);
    const { autoCompactRefresh } = await import('../../src/core/compact.ts');
    await autoCompactRefresh({
        workDir: home,
        instructions: '',
        cli: 'codex-app',
        model: 'gpt-5.5',
        sessionBucket: capturedBucket,
    });
    assert.equal(bucketSessionId(capturedBucket), undefined, 'captured bucket must be cleared');
    assert.equal(bucketSessionId('codex-app'), 'thread-legacy',
        'auto compact must not recompute a captured bucket into the legacy row');

    database.db.prepare('DELETE FROM session_buckets').run();
    const { settings } = await import('../../src/core/config.ts');
    settings['cli'] = 'claude';
    settings['model'] = 'sonnet';
    settings['workingDir'] = home;
    database.upsertSessionBucket.run('claude', 'thread-active', 'sonnet', null, 0);
    database.upsertSessionBucket.run('codex-app:scope-a', 'thread-a', 'gpt-5.5', null, 0);
    database.upsertSessionBucket.run('codex-app:scope-b:gpt-5.5:high', 'thread-b', 'gpt-5.5', null, 0);
    database.upsertSessionBucket.run('pi', 'thread-pi', 'default', null, 0);
    const { clearSessionState } = await import('../../src/core/session-ops.ts');
    await clearSessionState();
    assert.equal(bucketSessionId('claude'), undefined, 'active legacy bucket must be cleared');
    assert.equal(bucketSessionId('codex-app:scope-a'), undefined, 'native scoped bucket must be cleared');
    assert.equal(bucketSessionId('codex-app:scope-b:gpt-5.5:high'), undefined,
        'fallback scoped bucket must be cleared');
    assert.equal(bucketSessionId('pi'), 'thread-pi', 'unrelated CLI buckets must remain');

    // The singleton session row and the bucket row have to move together. A
    // singleton pointing at a thread the bucket never recorded sends the next
    // resume somewhere the server has no rollout for.
    database.db.prepare('DELETE FROM session_buckets').run();
    database.updateSession.run('codex-app', 'thread-before', 'gpt-5.5', 'auto', home, 'high');
    database.upsertSessionBucket.run('codex-app:scope-tx:gpt-5.5:high', 'thread-before', 'gpt-5.5', null, 0);
    database.db.exec(`
        CREATE TRIGGER reject_bucket_write BEFORE UPDATE ON session_buckets
        WHEN NEW.session_id = 'thread-after'
        BEGIN SELECT RAISE(ABORT, 'forced bucket failure'); END
    `);
    let threw: string | null = null;
    try {
        persistence.persistMainSession({
            persistenceOwner: persistence.getSessionOwnershipGeneration('scope-tx'),
            scopeKey: 'scope-tx',
            sessionId: 'thread-after',
            cli: 'codex-app',
            model: 'gpt-5.5',
            effort: 'high',
            codexAppBucket: 'codex-app:scope-tx:gpt-5.5:high',
        });
    } catch (error) {
        threw = (error as Error).message;
    }
    database.db.exec('DROP TRIGGER reject_bucket_write');
    assert.match(threw ?? '', /forced bucket failure/, 'the injected bucket failure must surface');
    const singleton = database.getSession() as { session_id?: string } | undefined;
    assert.equal(singleton?.session_id, 'thread-before',
        'a failed bucket write must roll the singleton row back with it');
    assert.equal(bucketSessionId('codex-app:scope-tx:gpt-5.5:high'), 'thread-before');
} finally {
    database.closeDb();
}
