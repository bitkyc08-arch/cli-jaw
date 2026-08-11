import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSource } from './source-normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pipelineSrc = readSource(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');
const routeSrc = readSource(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');
const registrySrc = readSource(join(__dirname, '../../src/orchestrator/worker-registry.ts'), 'utf8');

test('worker classification: dispatch route marks non-done worker results as failures', () => {
    assert.ok(
        routeSrc.includes('finishWorker(slot.agentId') &&
        routeSrc.includes('failWorker(slot.agentId'),
        'dispatch route should record success and failure worker outcomes separately',
    );
});

test('worker classification: replay contract only runs for done workers', () => {
    assert.ok(
        pipelineSrc.includes('claimWorkerReplay(pr.agentId, scopeKey)'),
        'replay should claim the completed worker result within its owning scope',
    );
    assert.ok(
        pipelineSrc.includes('listPendingWorkerResults(scopeKey)'),
        'replay drain should list only pending results from its owning scope',
    );
});

test('worker classification: pending replay list only includes done worker slots', () => {
    assert.ok(
        registrySrc.includes("slot.state === 'done' && slot.pendingReplay"),
        'registry should exclude failed workers from replay drain',
    );
});
