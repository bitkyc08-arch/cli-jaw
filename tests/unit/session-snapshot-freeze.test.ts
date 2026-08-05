// #prompt-cache round-1 — frozen task snapshot lifecycle.
// The snapshot is written at spawn time as a placeholder bucket row, must
// survive the end-of-turn session upsert byte-identical, and must die with
// the bucket on any clear (compact / model change / stale TTL).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    getSessionBucket, upsertSessionBucket, setSessionBucketSnapshot, clearSessionBucket,
} from '../../src/core/db.ts';

type BucketRow = {
    session_id?: string | null;
    model?: string | null;
    memory_snapshot?: string | null;
    updated_at?: string | null;
};

const BUCKET = `test-freeze-${process.pid}`;

test('SSF-001: spawn-time snapshot write creates a placeholder that stays non-resumable', () => {
    clearSessionBucket.run(BUCKET);
    setSessionBucketSnapshot.run(BUCKET, 'test-model', '## Task Snapshot\nfrozen-bytes-v1');
    const row = getSessionBucket.get(BUCKET) as BucketRow;
    assert.equal(row.memory_snapshot, '## Task Snapshot\nfrozen-bytes-v1');
    assert.equal(row.session_id, '', 'placeholder session id must stay falsy so resume checks treat it as fresh');
});

test('SSF-002: end-of-turn session upsert preserves the frozen snapshot bytes', () => {
    upsertSessionBucket.run(BUCKET, 'sid-123', 'test-model', 'rk', 42);
    const row = getSessionBucket.get(BUCKET) as BucketRow;
    assert.equal(row.session_id, 'sid-123', 'real session capture lands');
    assert.equal(row.memory_snapshot, '## Task Snapshot\nfrozen-bytes-v1', 'snapshot must survive the upsert byte-identical');
});

test('SSF-003: re-freezing overwrites only the snapshot, keeping the session', () => {
    setSessionBucketSnapshot.run(BUCKET, 'test-model', 'frozen-bytes-v2');
    const row = getSessionBucket.get(BUCKET) as BucketRow;
    assert.equal(row.memory_snapshot, 'frozen-bytes-v2');
    assert.equal(row.session_id, 'sid-123', 'existing session id must not be clobbered by a snapshot write');
});

test('SSF-004: bucket clear kills the snapshot with the row', () => {
    clearSessionBucket.run(BUCKET);
    assert.equal(getSessionBucket.get(BUCKET), undefined, 'row (and snapshot) gone after clear');
});

test('SSF-005: spawn wiring — capture before mutation, frozen reuse, pipeline stays out', () => {
    const root = join(import.meta.dirname, '..', '..');
    const spawnSrc = readFileSync(join(root, 'src/agent/spawn.ts'), 'utf8');
    const captureIdx = spawnSrc.indexOf('const promptForSnapshot = prompt;');
    const bootstrapIdx = spawnSrc.indexOf('consumePendingBootstrapPrompt(');
    assert.ok(captureIdx > 0 && bootstrapIdx > 0 && captureIdx < bootstrapIdx,
        'snapshot input must be captured before the bootstrap prompt mutation');
    assert.ok(spawnSrc.includes('bucketRow.memory_snapshot'), 'resume turns must read the frozen snapshot');
    assert.ok(spawnSrc.includes('setSessionBucketSnapshot.run(currentBucket'), 'fresh turns must store the snapshot');
    const sysIdx = spawnSrc.indexOf('const sysPrompt = customSysPrompt');
    const resumeIdx = spawnSrc.indexOf('const isResume = empSid');
    assert.ok(resumeIdx > 0 && sysIdx > resumeIdx, 'system prompt must be computed after the resume decision');
    const pipelineSrc = readFileSync(join(root, 'src/orchestrator/pipeline.ts'), 'utf8');
    assert.ok(!pipelineSrc.includes('buildMemoryInjection'), 'pipeline must not regenerate snapshots per turn');
    assert.ok(!/memorySnapshot\s*[,:]/.test(pipelineSrc), 'pipeline must not pass a memorySnapshot option to spawn');
});
