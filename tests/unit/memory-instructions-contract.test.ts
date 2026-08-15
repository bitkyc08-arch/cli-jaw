import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('memory prompt templates show exact save command arity', () => {
    const a1 = read('src/prompt/templates/a1-system.md');
    const employee = read('src/prompt/templates/employee.md');

    for (const src of [a1, employee]) {
        assert.ok(src.includes('cli-jaw memory save <file> <content>'));
        assert.ok(src.includes('Never call `cli-jaw memory save` without a destination file'));
    }
});

test('memory prompt templates separate L1 local memory from L2 dashboard memory', () => {
    const a1 = read('src/prompt/templates/a1-system.md');
    const employee = read('src/prompt/templates/employee.md');

    assert.ok(a1.includes('L1 default'));
    assert.ok(a1.includes('instance-local memory'));
    assert.ok(a1.includes('L2 on demand'));
    assert.ok(a1.includes('cross-instance dashboard federation'));
    assert.ok(a1.includes('Dashboard memory is read-only'));
    assert.ok(a1.includes('do not use it for routine lookup'));
    assert.ok(employee.includes('Use L1 `cli-jaw memory ...` first'));
    assert.ok(employee.includes('L2 `cli-jaw dashboard memory ...`'));
    assert.ok(employee.includes('L2 dashboard memory is read-only'));
});

test('memory prompt templates describe dashboard embedding as default-off add-on', () => {
    const a1 = read('src/prompt/templates/a1-system.md');
    const employee = read('src/prompt/templates/employee.md');

    assert.ok(a1.includes('Embedding search is optional and default OFF'));
    assert.ok(a1.includes('cli-jaw dashboard memory state'));
    assert.ok(a1.includes('cli-jaw dashboard memory estimate'));
    assert.ok(a1.includes('cli-jaw dashboard memory config get'));
    assert.ok(!a1.includes('cli-jaw memory embed status'));
    assert.ok(!a1.includes('cli-jaw memory embed estimate'));
    assert.ok(employee.includes('embedding is default OFF unless configured'));
});

test('memory skill source documents L1/L2 scope without making embedding default', () => {
    const skill = read('skills_ref/jaw-memory/SKILL.md');

    assert.ok(skill.includes('## Scope: L1 vs L2'));
    assert.ok(skill.includes('L1 instance-local memory'));
    assert.ok(skill.includes('cli-jaw memory search/read/save'));
    assert.ok(skill.includes('L2 dashboard memory'));
    assert.ok(skill.includes('cli-jaw dashboard memory search/read/instances'));
    assert.ok(skill.includes('cross-instance federation; read-only'));
    assert.ok(skill.includes('Embedding search is optional and default OFF'));
});

test('compact handoff reminds agents that memory save requires a file', () => {
    const compact = read('src/core/compact.ts');

    assert.ok(compact.includes('cli-jaw memory save <file> <content>'));
    assert.ok(compact.includes('structured/episodes/live/YYYY-MM-DD.md'));
});

test('memory CLI save usage includes actionable examples', () => {
    const memory = read('bin/commands/memory.ts');

    assert.ok(memory.includes('Usage: cli-jaw memory save <file> <content>'));
    assert.ok(memory.includes('Examples:'));
    assert.ok(memory.includes('structured/profile.md'));
    assert.ok(memory.includes('structured/semantic/cli-jaw.md'));
    assert.ok(memory.includes('structured/episodes/live/2026-04-26.md'));
});

test('memory CLI help text includes L2 cross-instance commands', () => {
    const memory = read('bin/commands/memory.ts');

    assert.ok(memory.includes('Cross-instance (L2)'));
    assert.ok(memory.includes('cli-jaw dashboard memory search'));
    assert.ok(memory.includes('cli-jaw dashboard memory read'));
    assert.ok(memory.includes('cli-jaw dashboard memory instances'));
});
