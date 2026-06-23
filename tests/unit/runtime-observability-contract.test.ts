import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    normalizeBgTaskStatus,
    normalizeWorkerRunStatus,
} from '../../src/shared/runtime-observability.ts';

const root = join(import.meta.dirname, '..', '..');

test('runtime observability status categories normalize worker runs and background tasks', () => {
    assert.equal(normalizeWorkerRunStatus('running'), 'running');
    assert.equal(normalizeWorkerRunStatus('done'), 'succeeded');
    assert.equal(normalizeWorkerRunStatus('failed'), 'failed');
    assert.equal(normalizeWorkerRunStatus('cancelled'), 'cancelled');

    assert.equal(normalizeBgTaskStatus('running'), 'running');
    assert.equal(normalizeBgTaskStatus('complete'), 'succeeded');
    assert.equal(normalizeBgTaskStatus('failed'), 'failed');
    assert.equal(normalizeBgTaskStatus('cancelled'), 'cancelled');
    assert.equal(normalizeBgTaskStatus('orphaned'), 'orphaned');
});

test('runtime observability shared module stays dependency-root', () => {
    const src = readFileSync(join(root, 'src/shared/runtime-observability.ts'), 'utf8');
    assert.doesNotMatch(src, /from ['"].*\.\.\/(?:orchestrator|bgtask)\//);
    assert.doesNotMatch(src, /from ['"].*src\/(?:orchestrator|bgtask)\//);
});
