import test from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from './source-normalize.js';
import { join } from 'node:path';

const __dirname = import.meta.dirname;
const projectRoot = join(__dirname, '../..');
const stateMachineSrc = readSource(join(projectRoot, 'src/orchestrator/state-machine.ts'), 'utf8');
const goalCliSrc = readSource(join(projectRoot, 'bin/commands/goal.ts'), 'utf8');

test('C phase prompt tells agents to run orchestrate D (with --attest) instead of suggesting it', () => {
    // Phase 60: the executable instruction must carry --attest — a bare `orchestrate D` 409s.
    assert.match(stateMachineSrc, /RUN \\\\?`cli-jaw orchestrate D --attest\\\\?` now/,
        'C phase should require executing the D transition command WITH --attest evidence');
    assert.ok(stateMachineSrc.includes('Do not merely suggest it'),
        'C phase should distinguish command execution from suggestion text');
});

test('D phase prompt does not tell agents to run orchestrate D again', () => {
    assert.ok(!stateMachineSrc.includes('`cli-jaw orchestrate D`로 마무리하세요'),
        'D phase should not ask for the D transition after already entering D');
});

test('goal CLI help documents 10000 character objective limit', () => {
    assert.ok(goalCliSrc.includes('up to 10000 characters'),
        'goal set help should document the objective character limit');
});
