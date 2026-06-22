import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const cliSrc = readFileSync(join(projectRoot, 'bin/cli-jaw.ts'), 'utf8');
const workerSrc = readFileSync(join(projectRoot, 'bin/commands/worker.ts'), 'utf8');
const commandsDoc = readFileSync(join(projectRoot, 'structure/commands.md'), 'utf8');

test('root CLI registers worker command', () => {
    assert.match(cliSrc, /'worker'/);
    assert.match(cliSrc, /case 'worker':/);
    assert.match(cliSrc, /commands\/worker\.js/);
});

test('worker command queries status and watch progress endpoints', () => {
    assert.match(workerSrc, /worker status \[agent\|runId\] \[--recent N\] \[--json\]/);
    assert.match(workerSrc, /worker watch \[agent\|runId\] \[--json\]/);
    assert.match(workerSrc, /\/api\/orchestrate\/worker-progress/);
    assert.match(workerSrc, /\/api\/orchestrate\/worker-progress\/\$\{encodeURIComponent\(agentId\)\}/);
    assert.match(workerSrc, /setTimeout|sleep\(2_000\)/);
});

test('worker command exposes explicit raw output read by runId only', () => {
    assert.match(workerSrc, /worker read <runId> \[--offset N --limit N\] \[--json\]/);
    assert.match(workerSrc, /worker read <runId> \[--tail N\]/);
    assert.match(workerSrc, /function requireRunId/);
    assert.match(workerSrc, /worker read requires an explicit runId/);
    assert.match(workerSrc, /\/api\/orchestrate\/worker-runs\/\$\{encodeURIComponent\(runId\)\}\/output/);
    assert.match(workerSrc, /\/api\/orchestrate\/worker-runs\/\$\{encodeURIComponent\(runId\)\}/);
    assert.match(workerSrc, /const offset = Math\.max\(0, run\.outputBytes - tail\)/);
    assert.match(workerSrc, /More output available: cli-jaw worker read/);
});

test('worker command keeps status/watch on safe-summary surfaces', () => {
    const readIdx = workerSrc.indexOf("if (command === 'read')");
    const statusIdx = workerSrc.indexOf("if (command === 'status')");
    assert.ok(readIdx >= 0 && statusIdx > readIdx, 'read branch should be isolated before safe status/watch flow');
    const safeStatusWatchBlock = workerSrc.slice(statusIdx);
    assert.doesNotMatch(safeStatusWatchBlock, /worker-runs\/\$\{encodeURIComponent\(runId\)\}\/output/);
    assert.match(workerSrc, /fetchRunRecords\(\)/);
    assert.match(workerSrc, /numericFlag\('--recent'\)/);
});

test('worker command prints lifecycle attention from progress snapshots', () => {
    assert.match(workerSrc, /phase\?: string \| null/);
    assert.match(workerSrc, /console\.log\(`phase:/);
    assert.match(workerSrc, /attention\?:/);
    assert.match(workerSrc, /run\.attention\?\.message/);
    assert.match(workerSrc, /console\.log\(`attention:/);
});

test('worker command prints run identity from progress snapshots', () => {
    assert.match(workerSrc, /runId\?: string/);
    assert.match(workerSrc, /snapshot\.runId/);
    assert.match(workerSrc, /console\.log\(`runId:/);
    assert.match(workerSrc, /console\.log\(`agentId:/);
});

test('worker command resolves display names through employees API', () => {
    assert.match(workerSrc, /unwrapEmployeeSummaries/);
    assert.match(workerSrc, /\/api\/employees/);
    assert.match(workerSrc, /e\.name === nameOrId \|\| e\.id === nameOrId/);
});

test('structure commands document worker progress and employee sessions-reset surfaces', () => {
    assert.match(commandsDoc, /`worker`\s*\|\s*`bin\/commands\/worker\.ts`\s*\|[^|\n]*status \[agent\\\|runId\][^|\n]*watch \[agent\\\|runId\]/);
    assert.match(commandsDoc, /snapshot\.workers[^)\n]*running-only/);
    assert.match(commandsDoc, /`employee`\s*\|\s*`bin\/commands\/employee\.ts`\s*\|[^|\n]*sessions-reset \[--port 3457\]/);
});
