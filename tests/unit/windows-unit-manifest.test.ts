import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readManifest, MANIFEST_PATH } from '../../scripts/ci/windows-unit-manifest.mjs';

const projectRoot = resolve(import.meta.dirname, '..', '..');

function fixture(content: string, files: string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'cli-jaw-wum-'));
    mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
    mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
    for (const f of files) writeFileSync(join(root, f), '');
    writeFileSync(join(root, MANIFEST_PATH), content);
    return root;
}

test('WUM-001: the committed manifest validates and lists only existing tests/unit files', () => {
    const entries = readManifest(MANIFEST_PATH, { root: projectRoot });
    assert.ok(entries.length >= 15, `expected the 15 Windows lane files, got ${entries.length}`);
    assert.equal(new Set(entries).size, entries.length);
    for (const e of entries) assert.match(e, /^tests\/unit\/[A-Za-z0-9_-]+\.test\.ts$/);
});

test('WUM-002: comments and blank lines are ignored, order is preserved', () => {
    const root = fixture('# header\n\ntests/unit/b.test.ts\n  tests/unit/a.test.ts  \n', ['tests/unit/a.test.ts', 'tests/unit/b.test.ts']);
    assert.deepEqual(readManifest(MANIFEST_PATH, { root }), ['tests/unit/b.test.ts', 'tests/unit/a.test.ts']);
});

test('WUM-003: empty, duplicate, out-of-tree, and missing entries each throw with the reason', () => {
    assert.throws(() => readManifest(MANIFEST_PATH, { root: fixture('# only comments\n') }), /empty manifest/);
    assert.throws(() => readManifest(MANIFEST_PATH, { root: fixture('tests/unit/a.test.ts\ntests/unit/a.test.ts\n', ['tests/unit/a.test.ts']) }), /duplicate entry/);
    assert.throws(() => readManifest(MANIFEST_PATH, { root: fixture('tests/integration/x.test.ts\n') }), /invalid entry/);
    assert.throws(() => readManifest(MANIFEST_PATH, { root: fixture('tests/unit/../../package.json\n') }), /invalid entry/);
    assert.throws(() => readManifest(MANIFEST_PATH, { root: fixture('tests/unit/*.test.ts\n') }), /invalid entry/);
    assert.throws(() => readManifest(MANIFEST_PATH, { root: fixture('tests/unit/gone.test.ts\n') }), /missing file/);
    assert.throws(() => readManifest('scripts/ci/nope.txt', { root: fixture('') }), /manifest missing/);
});

test('WUM-004: CLI --print emits the validated list and exits 1 on a defect', () => {
    const ok = spawnSync(process.execPath, ['scripts/ci/windows-unit-manifest.mjs', '--print'], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const printed = ok.stdout.trim().split('\n');
    assert.deepEqual(printed, readManifest(MANIFEST_PATH, { root: projectRoot }));
    const bad = fixture('tests/unit/gone.test.ts\n');
    const fail = spawnSync(process.execPath, [join(projectRoot, 'scripts/ci/windows-unit-manifest.mjs'), '--print', join(bad, MANIFEST_PATH)], { cwd: bad, encoding: 'utf8' });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /missing file/);
    assert.equal(fail.stdout, '');
});

