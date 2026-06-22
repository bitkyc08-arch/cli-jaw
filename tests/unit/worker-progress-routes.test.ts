import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const routeSrc = readFileSync(join(projectRoot, 'src/routes/orchestrate.ts'), 'utf8');

test('orchestrate routes expose worker progress endpoints', () => {
    assert.match(routeSrc, /app\.get\('\/api\/orchestrate\/worker-progress'/);
    assert.match(routeSrc, /app\.get\('\/api\/orchestrate\/worker-progress\/:agentId'/);
    assert.match(routeSrc, /listWorkerProgressSnapshots\(\)/);
    assert.match(routeSrc, /getWorkerProgressSnapshot\(agentId\)/);
});

test('dispatch route supports wait false async start response', () => {
    const routeStart = routeSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');
    const routeBlock = routeSrc.slice(routeStart, routeStart + 18000);

    assert.match(routeBlock, /const wait = req\.body\?\.wait !== false/);
    assert.match(routeBlock, /void runDispatch\(false\)/);
    assert.match(routeBlock, /res\.status\(202\)\.json/);
    assert.match(routeBlock, /agentId: slot\.agentId/);
    assert.match(routeBlock, /runId: slot\.runId/);
    assert.match(routeBlock, /progress: getWorkerProgressSnapshot\(slot\.agentId\)/);
});

test('dispatch busy response includes active run identity', () => {
    const routeStart = routeSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');
    const routeBlock = routeSrc.slice(routeStart, routeStart + 7000);

    assert.match(routeBlock, /error: 'worker_busy'/);
    assert.match(routeBlock, /agentId: err\.existing\.agentId/);
    assert.match(routeBlock, /runId: err\.existing\.runId/);
});

test('worker result route preserves existing fields and adds progress', () => {
    const routeStart = routeSrc.indexOf("app.get('/api/orchestrate/worker/:agentId/result'");
    assert.ok(routeStart >= 0, 'worker result route should exist');
    const routeBlock = routeSrc.slice(routeStart, routeStart + 3000);

    assert.match(routeBlock, /state: slot\.state/);
    assert.match(routeBlock, /runId: slot\.runId/);
    assert.match(routeBlock, /agentId: slot\.agentId/);
    assert.match(routeBlock, /result: slot\.result/);
    assert.match(routeBlock, /tools: slot\.tools/);
    assert.match(routeBlock, /progress: getWorkerProgressSnapshot\(slot\.agentId\)/);
});
