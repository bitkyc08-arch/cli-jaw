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
    assert.match(workerSrc, /worker status \[agent\]/);
    assert.match(workerSrc, /worker watch \[agent\]/);
    assert.match(workerSrc, /\/api\/orchestrate\/worker-progress/);
    assert.match(workerSrc, /\/api\/orchestrate\/worker-progress\/\$\{encodeURIComponent\(agentId\)\}/);
    assert.match(workerSrc, /setTimeout|sleep\(2_000\)/);
});

test('worker command prints lifecycle attention from progress snapshots', () => {
    assert.match(workerSrc, /phase\?: string \| null/);
    assert.match(workerSrc, /console\.log\(`phase:/);
    assert.match(workerSrc, /attention\?:/);
    assert.match(workerSrc, /run\.attention\?\.message/);
    assert.match(workerSrc, /console\.log\(`attention:/);
});

test('worker command resolves display names through employees API', () => {
    assert.match(workerSrc, /unwrapEmployeeSummaries/);
    assert.match(workerSrc, /\/api\/employees/);
    assert.match(workerSrc, /e\.name === nameOrId \|\| e\.id === nameOrId/);
});

test('structure commands document worker progress and employee sessions-reset surfaces', () => {
    assert.match(commandsDoc, /`worker`\s*\|\s*`bin\/commands\/worker\.ts`\s*\|[^|\n]*status \[agent\][^|\n]*watch \[agent\]/);
    assert.match(commandsDoc, /snapshot\.workers[^)\n]*running-only/);
    assert.match(commandsDoc, /`employee`\s*\|\s*`bin\/commands\/employee\.ts`\s*\|[^|\n]*sessions-reset \[--port 3457\]/);
});
