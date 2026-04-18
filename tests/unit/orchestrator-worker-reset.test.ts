import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pipelineSrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');

test('reset: orchestrateReset does NOT kill the main agent (preserves conversation)', () => {
    const resetStart = pipelineSrc.indexOf('export async function orchestrateReset');
    const resetBlock = pipelineSrc.slice(resetStart, resetStart + 900);
    assert.ok(!resetBlock.includes("killActiveAgent"), 'reset must NOT kill the main agent');
    assert.ok(!resetBlock.includes("messageQueue.length = 0"), 'reset must NOT empty the message queue');
    assert.ok(resetBlock.includes('clearAllWorkers()'), 'reset should still clear worker registry');
});

test('reset: orchestrateReset terminates each live worker before cancel/clear', () => {
    const resetStart = pipelineSrc.indexOf('export async function orchestrateReset');
    const resetBlock = pipelineSrc.slice(resetStart, resetStart + 900);
    const workerKillIdx = resetBlock.indexOf('killAgentById(w.agentId)');
    const cancelIdx = resetBlock.indexOf('cancelWorker(w.agentId)');
    assert.ok(workerKillIdx > 0, 'reset should kill each live worker');
    assert.ok(cancelIdx > workerKillIdx, 'reset should cancel registry slot after kill attempt');
});
