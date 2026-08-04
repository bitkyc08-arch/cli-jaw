import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-shape assertions are deliberate here: doctor.ts and postinstall.ts
 * run checks against the live machine at import time, so behavioral testing of
 * their lanes would execute installer logic on the runner. The behavioral
 * proof lives in platform-kind.test.ts, which covers the functions these files
 * now call.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const doctor = fs.readFileSync(path.join(root, 'bin/commands/doctor.ts'), 'utf8');
const postinstall = fs.readFileSync(path.join(root, 'bin/postinstall.ts'), 'utf8');

function executableSource(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

test('doctor gates the WSL lane behind a windows-native check', () => {
    assert.match(doctor, /if \(isWindowsNative\(\)\) \{/);
    assert.match(doctor, /\} else if \(isWSL\(\)\) \{/);
    assert.match(doctor, /CLI tools \(Windows-native\)/);
});

test('doctor still reports the WSL /mnt lane', () => {
    assert.match(doctor, /CLI tools \(WSL-native\)/);
    assert.match(doctor, /startsWith\('\/mnt\/'\)/);
});

test('the Windows lane reports rejected candidates rather than re-checking accepted ones', () => {
    assert.match(doctor, /detected\.rejected \?\? \[\]/);
    assert.match(doctor, /not launchable/);
});

test('doctor --json exposes the resolved platform kind', () => {
    assert.match(doctor, /platform: resolvePlatformKind\(\)/);
});

test('postinstall no longer treats WSLENV or win32 as WSL evidence', () => {
    const executable = executableSource(postinstall);
    assert.doesNotMatch(executable, /WSLENV/);
    assert.doesNotMatch(executable, /looksLikeWsl/);
    assert.match(executable, /isWindowsNodeLaunchedFromWsl\(/);
});

test('postinstall reads the npm invocation cwd, not the lifecycle cwd', () => {
    // npm runs lifecycle scripts from the package root, so process.cwd() here
    // would make the warning unreachable.
    assert.match(postinstall, /resolveInvocationCwd\(\)/);
});

test('both files import the canonical resolver', () => {
    for (const [name, source] of [['doctor.ts', doctor], ['postinstall.ts', postinstall]] as const) {
        assert.match(
            source,
            /from\s+'[^']*platform-kind\.js'/,
            `${name} must import the resolver`,
        );
    }
});
