import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const routeSrc = readFileSync(join(projectRoot, 'src/routes/orchestrate.ts'), 'utf8');
const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf8');
const storeSrc = readFileSync(join(projectRoot, 'src/orchestrator/worker-run-store.ts'), 'utf8');

test('orchestrate routes expose worker-runs safe metadata, events, and bounded output endpoints', () => {
    assert.match(routeSrc, /app\.get\('\/api\/orchestrate\/worker-runs'/);
    assert.match(routeSrc, /app\.get\('\/api\/orchestrate\/worker-runs\/:runId'/);
    assert.match(routeSrc, /app\.get\('\/api\/orchestrate\/worker-runs\/:runId\/events'/);
    assert.match(routeSrc, /app\.get\('\/api\/orchestrate\/worker-runs\/:runId\/output'/);
    assert.match(routeSrc, /listWorkerRunRecords\(\)/);
    assert.match(routeSrc, /getWorkerRunRecord\(runId\)/);
    assert.match(routeSrc, /listWorkerRunEvents\(runId\)/);
    assert.match(routeSrc, /readWorkerRunOutput\(runId, \{ offset, limit \}\)/);
});

test('worker-runs metadata store redacts output file and keeps raw text behind output route', () => {
    assert.match(storeSrc, /Omit<WorkerRunRecord, 'outputFile'>/);
    assert.match(storeSrc, /hasOutput: record\.outputBytes > 0/);
    assert.match(storeSrc, /readWorkerRunOutput/);
    assert.doesNotMatch(routeSrc, /run:\s*\{[^}]*outputFile/s);
});

test('worker-runs routes are exempt from localhost poll rate limiting', () => {
    assert.match(serverSrc, /req\.path\.startsWith\('\/api\/orchestrate\/worker-runs'\)/);
});
