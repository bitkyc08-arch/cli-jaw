import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const distributeSrc = readFileSync(join(projectRoot, 'src/orchestrator/distribute.ts'), 'utf8');
const progressSrc = readFileSync(join(projectRoot, 'src/orchestrator/worker-progress.ts'), 'utf8');
const registrySrc = readFileSync(join(projectRoot, 'src/orchestrator/worker-registry.ts'), 'utf8');

test('worker progress DTO includes lifecycle attention metadata', () => {
    assert.match(progressSrc, /export type WorkerProgressAttentionKind/);
    assert.match(progressSrc, /export interface WorkerProgressAttention/);
    assert.match(progressSrc, /attention\?: WorkerProgressAttention/);
});

test('worker monitor callbacks update progress attention before broadcasting', () => {
    assert.match(distributeSrc, /markWorkerStalled\(id\);\s*broadcast\('worker_stalled'/s);
    assert.match(distributeSrc, /markWorkerDisconnected\(id, code\);\s*broadcast\('worker_disconnected'/s);
    assert.match(distributeSrc, /markWorkerTimedOut\(id\);\s*broadcast\('worker_timeout'/s);
    assert.match(distributeSrc, /monitor\.touch\(source as 'stdout' \| 'stderr' \| 'acp' \| 'heartbeat'\);\s*markWorkerActive\(empId\);/s);
});

test('worker replay states are exposed through progress attention', () => {
    assert.match(registrySrc, /kind: slot\.replayClaimed \? 'replay_claimed' : 'pending_replay'/);
    assert.match(registrySrc, /kind: 'replay_failed'/);
    assert.match(registrySrc, /Worker result replay failed after 3 attempts/);
});
