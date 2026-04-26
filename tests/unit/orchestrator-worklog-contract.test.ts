import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const pipelineSrc = readFileSync(join(projectRoot, 'src/orchestrator/pipeline.ts'), 'utf8');
const distributeSrc = readFileSync(join(projectRoot, 'src/orchestrator/distribute.ts'), 'utf8');

test('OWC-001: pipeline imports createWorklog and resolves worklog seed', () => {
    assert.ok(pipelineSrc.includes('createWorklog'));
    assert.ok(pipelineSrc.includes('pickWorklogSeed'));
    assert.ok(pipelineSrc.includes('ctx?.originalPrompt'));
    assert.ok(pipelineSrc.includes('planningTask'));
    assert.ok(pipelineSrc.includes('userText'));
});

test('OWC-002: initial planning turn creates worklog before setState', () => {
    const createIdx = pipelineSrc.indexOf('createWorklog(worklogSeed');
    // setState signature now includes scope + title: setState('P', nextCtx, scope, ...)
    const setStateIdx = pipelineSrc.indexOf("setState('P', nextCtx, scope");
    assert.notEqual(createIdx, -1, 'createWorklog(worklogSeed...) must exist');
    assert.notEqual(setStateIdx, -1, "setState('P', nextCtx, scope...) must exist");
    assert.ok(createIdx < setStateIdx, 'worklog should be created before setState');
});

test('OWC-003: worker handoff keeps object-shaped worklog contract', () => {
    assert.ok(pipelineSrc.includes("{ path: args.worklogPath }"));
});

test('OWC-004: distribute gates worklog prompt on truthy path', () => {
    assert.ok(distributeSrc.includes('const worklogPath = String(worklog?.path || \'\').trim()'));
    assert.ok(distributeSrc.includes('const worklogBlock = worklogPath'));
    assert.ok(distributeSrc.includes('if (worklogPath) {'));
});
