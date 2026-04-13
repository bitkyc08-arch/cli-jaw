import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pipelineSrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');
const registrySrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/worker-registry.ts'), 'utf8');

test('worker classification: pipeline marks non-done worker results as failures', () => {
    assert.ok(
        pipelineSrc.includes("if (result.status === 'done')") &&
        pipelineSrc.includes('failWorker(emp.id'),
        'pipeline should branch done vs error before recording worker outcome',
    );
});

test('worker classification: replay contract only runs for done workers', () => {
    // In patch3, replay drain is separate from worker execution.
    // The replay drain in orchestrate() calls claimWorkerReplay() and listPendingWorkerResults()
    // only returns done workers (checked in worker-registry).
    assert.ok(
        pipelineSrc.includes('claimWorkerReplay(pr.agentId)'),
        'replay should be gated behind claimWorkerReplay',
    );
    assert.ok(
        pipelineSrc.includes('listPendingWorkerResults'),
        'replay drain should use listPendingWorkerResults which filters done workers',
    );
});

test('worker classification: pending replay list only includes done worker slots', () => {
    assert.ok(
        registrySrc.includes("slot.state === 'done' && slot.pendingReplay"),
        'registry should exclude failed workers from replay drain',
    );
});
