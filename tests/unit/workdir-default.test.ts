// Multi-Instance Phase 1: workingDir default 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, JAW_HOME } from '../../src/core/config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const builderSrc = readFileSync(join(__dirname, '..', '..', 'src', 'prompt', 'builder.ts'), 'utf8');

test('P1-001: DEFAULT_SETTINGS.workingDir === JAW_HOME', () => {
    assert.equal(DEFAULT_SETTINGS.workingDir, JAW_HOME);
    assert.ok(DEFAULT_SETTINGS.workingDir.includes('.cli-jaw'));
});

test('P1-002: A2_DEFAULT prompt contains ~/.cli-jaw not bare ~/', () => {
    const a2Match = builderSrc.match(/const A2_DEFAULT = `([\s\S]*?)`;/);
    assert.ok(a2Match, 'A2_DEFAULT should exist in builder.ts');
    const a2Content = a2Match[1];
    assert.ok(a2Content.includes('~/.cli-jaw'), 'Should reference ~/.cli-jaw');
    assert.ok(!a2Content.includes('- ~/\n'), 'Should NOT have bare "- ~/"');
});
