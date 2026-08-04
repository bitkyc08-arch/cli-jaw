import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const home = process.env['CLI_JAW_HOME'];
assert.ok(home && isAbsolute(home) && home.startsWith(tmpdir()) && home !== tmpdir(),
    'fixture requires an isolated absolute temp CLI_JAW_HOME before importing db');

const database = await import('../../src/core/db.ts');

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
} finally {
    database.closeDb();
}
