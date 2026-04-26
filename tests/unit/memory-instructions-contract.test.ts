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
