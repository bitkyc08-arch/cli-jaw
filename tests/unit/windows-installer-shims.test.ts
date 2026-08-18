/**
 * #381 regressions: installer and source-mode spawns must never depend on
 * npm .bin shims (extensionless POSIX scripts / EINVAL .cmd) and install.ps1
 * must survive Set-StrictMode with the node manifest entry (no tag key).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveTsxSpawn } from '../../src/core/tsx-spawn.ts';

const repoRoot = join(new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '..', '..');
const onWindows = process.platform === 'win32';

test('WIS-001: resolveTsxSpawn targets a JS entry through node, never a .bin shim', () => {
    const spec = resolveTsxSpawn('C:/proj', 'C:/proj/server.ts', null, {
        resolveTsxEntry: () => 'C:/proj/node_modules/tsx/dist/cli.mjs',
        execPath: 'C:/node/node.exe',
    });
    assert.equal(spec.command, 'C:/node/node.exe');
    assert.deepEqual(spec.args, ['C:/proj/node_modules/tsx/dist/cli.mjs', 'C:/proj/server.ts']);
    assert.ok(!spec.command.includes('.bin'));
});

test('WIS-002: --env-file precedes the tsx entry (node flag ordering)', () => {
    const spec = resolveTsxSpawn('C:/proj', 'C:/proj/server.ts', 'C:/proj/.env', {
        resolveTsxEntry: () => 'C:/proj/tsx-cli.mjs',
        execPath: 'node',
    });
    assert.deepEqual(spec.args, ['--env-file=C:/proj/.env', 'C:/proj/tsx-cli.mjs', 'C:/proj/server.ts']);
});

test('WIS-003: postinstall-guard resolves tsc via require.resolve, not .bin shims', () => {
    const src = readFileSync(new URL('../../scripts/postinstall-guard.cjs', import.meta.url), 'utf8');
    assert.match(src, /require\.resolve\('typescript\/bin\/tsc'/);
    assert.doesNotMatch(src, /'tsc\.cmd'|'tsc\.ps1'/);
});

test('WIS-004: install.ps1 -DryRun survives strict mode on a Node-less PATH', { skip: !onWindows }, () => {
    // The no-Node manifest branch is the regression surface (#381 F3): scrub
    // PATH so Resolve-CommandPath cannot find node and the bootstrap entry -
    // which has no tag key - is actually dereferenced.
    const script = new URL('../../scripts/install.ps1', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `$env:Path = 'C:\\WINDOWS\\system32'; & '${script}' -DryRun; exit 0`,
    ], { encoding: 'utf8', timeout: 60000 });
    assert.ok(!(r.stdout + r.stderr).includes('PropertyNotFoundException'),
        `strict-mode property error resurfaced: ${(r.stderr || '').slice(0, 300)}`);
    assert.ok((r.stdout || '').includes('[dry-run]'), `dry-run plan missing: ${(r.stdout || '').slice(0, 300)}`);
});

test('WIS-005: no-Node branch persists the bootstrapped runtime to User PATH', () => {
    const src = readFileSync(new URL('../../scripts/install.ps1', import.meta.url), 'utf8');
    // The Add-UserPathEntry call must appear in the bootstrap branch (right
    // after the process-PATH mutation), not only in the old-Node branch.
    const bootstrapIdx = src.indexOf('$env:Path = "$nodeDir;$env:Path"');
    assert.ok(bootstrapIdx !== -1, 'bootstrap PATH mutation moved; update this test');
    const after = src.slice(bootstrapIdx, bootstrapIdx + 200);
    assert.match(after, /Add-UserPathEntry \$nodeDir/);
});
