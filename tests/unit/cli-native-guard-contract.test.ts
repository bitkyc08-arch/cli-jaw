import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('CLI entrypoint runs native guard before importing subcommands', () => {
    const src = read('bin/cli-jaw.ts');
    const guardCall = src.indexOf('ensureNativeModulesReady(command);');
    const switchStart = src.indexOf('switch (command)');

    assert.ok(guardCall >= 0, 'native guard call must exist');
    assert.ok(switchStart >= 0, 'root command switch must exist');
    assert.ok(guardCall < switchStart, 'native guard must run before dynamic command imports');
    assert.match(src, /process\.execPath/);
    assert.match(src, /scripts', 'ensure-native-modules\.cjs'/);
});

test('native guard is skipped for help and version commands', () => {
    const src = read('bin/cli-jaw.ts');

    assert.match(src, /cmd === '--help'/);
    assert.match(src, /cmd === '-h'/);
    assert.match(src, /cmd === '--version'/);
    assert.match(src, /cmd === '-v'/);
});

test('ensure-native rebuilds from package root with current Node npm', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    assert.match(src, /const root = join\(__dirname, '\.\.'\)/);
    assert.match(src, /dirname\(process\.execPath\)/);
    assert.match(src, /adjacentNpm/);
    assert.match(src, /cwd: root/);
    assert.doesNotMatch(src, /cwd: process\.cwd\(\)/);
});
