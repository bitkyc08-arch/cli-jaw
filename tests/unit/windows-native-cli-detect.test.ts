import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    isSpawnableCliFile,
    prioritizeCliCandidates,
    windowsPathExt,
    buildCliDetectionEnv,
    listCliBinaryCandidates,
    selectSpawnableCliPath,
} from '../../src/core/cli-detect.js';

function fixtureDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-win-detect-'));
}

/** A minimal file carrying the PE/MZ header a real Windows executable has. */
function writeExe(dir: string, name: string): string {
    const target = path.join(dir, name);
    fs.writeFileSync(target, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    return target;
}

test('PATHEXT is read from the environment with the documented default', () => {
    assert.deepEqual(
        windowsPathExt({ PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
        ['.COM', '.EXE', '.BAT', '.CMD'],
    );
    // Case-insensitive key, lowercase value.
    assert.deepEqual(windowsPathExt({ PathExt: '.exe;.cmd' }), ['.EXE', '.CMD']);
    // Absent PATHEXT falls back to the Microsoft-documented default list.
    assert.ok(windowsPathExt({}).includes('.MSC'));
});

test('a .cmd shim is spawnable on win32 and a missing file is not', () => {
    const dir = fixtureDir();
    const cmdShim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(cmdShim, '@ECHO off\r\n');
    assert.deepEqual(isSpawnableCliFile(cmdShim, 'win32'), { ok: true });

    const missing = path.join(dir, 'nope.cmd');
    assert.equal(isSpawnableCliFile(missing, 'win32').ok, false);

    // The extensionless POSIX shim npm also writes must not pass as a
    // Windows executable.
    const posixShim = path.join(dir, 'codex');
    fs.writeFileSync(posixShim, '#!/bin/sh\n');
    assert.equal(isSpawnableCliFile(posixShim, 'win32').ok, false);

    // .ps1 is detected but not spawnable: spawn.ts routes non-.exe through
    // ComSpec, and cmd.exe cannot run a PowerShell script.
    const psShim = path.join(dir, 'codex.ps1');
    fs.writeFileSync(psShim, '#!/usr/bin/env pwsh\n');
    const psResult = isSpawnableCliFile(psShim, 'win32');
    assert.equal(psResult.ok, false);
    assert.match(psResult.reason ?? '', /powershell/i);
});

test('a directory is not spawnable even with an executable extension', () => {
    const dir = fixtureDir();
    const dirShim = path.join(dir, 'codex.cmd');
    fs.mkdirSync(dirShim);
    assert.equal(isSpawnableCliFile(dirShim, 'win32').ok, false);
});

test('an extension outside the launchable allowlist is not spawnable', () => {
    const dir = fixtureDir();
    const pyTool = path.join(dir, 'codex.py');
    fs.writeFileSync(pyTool, 'print(1)\n');
    // Even if .PY is in PATHEXT, ComSpec cannot launch it.
    assert.equal(isSpawnableCliFile(pyTool, 'win32').ok, false);
});

test('mixed-case extensions and paths with spaces are handled', () => {
    const dir = fixtureDir();
    const mixed = path.join(dir, 'Codex.CmD');
    fs.writeFileSync(mixed, '@ECHO off\r\n');
    assert.equal(isSpawnableCliFile(mixed, 'win32').ok, true);

    const spaced = path.join(dir, 'Program Files');
    fs.mkdirSync(spaced);
    const spacedTool = path.join(spaced, 'codex.BAT');
    fs.writeFileSync(spacedTool, '@ECHO off\r\n');
    assert.equal(isSpawnableCliFile(spacedTool, 'win32').ok, true);

    const com = writeExe(dir, 'legacy.COM');
    assert.equal(isSpawnableCliFile(com, 'win32').ok, true);
});

// .exe/.com are spawned directly, so an invalid one fails at launch with no
// fallback. Detection must reject it and let a valid .cmd win instead.
test('a text file named .exe is not spawnable', () => {
    const dir = fixtureDir();
    const fake = path.join(dir, 'codex.exe');
    fs.writeFileSync(fake, 'this is not a PE binary\n');

    const result = isSpawnableCliFile(fake, 'win32');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /MZ header/);

    // ...and a real PE passes.
    assert.equal(isSpawnableCliFile(writeExe(dir, 'good.exe'), 'win32').ok, true);
});

test('a broken .exe does not shadow a working .cmd shim', () => {
    const dir = fixtureDir();
    const broken = path.join(dir, 'codex.exe');
    fs.writeFileSync(broken, 'Error: binary not installed\n');
    const working = path.join(dir, 'codex.cmd');
    fs.writeFileSync(working, '@ECHO off\r\n');

    // Ranking still puts the .exe first; spawnability must then reject it and
    // fall through to the shim rather than returning an unlaunchable path.
    const ordered = prioritizeCliCandidates('codex', [broken, working], os.homedir(), 'win32');
    assert.deepEqual(ordered, [broken, working]);

    const selected = selectSpawnableCliPath(ordered, 'win32');
    assert.equal(selected.available, true);
    assert.equal(selected.path, working);
    assert.deepEqual(selected.rejected, [
        { path: broken, reason: 'not a windows executable (missing MZ header)' },
    ]);
});

test('windows candidates rank .exe over .cmd over .ps1 over the extensionless shim', () => {
    const ordered = prioritizeCliCandidates('codex', [
        'C:\\Users\\j\\AppData\\Roaming\\npm\\codex',
        'C:\\Users\\j\\AppData\\Roaming\\npm\\codex.ps1',
        'C:\\Users\\j\\AppData\\Roaming\\npm\\codex.cmd',
        'C:\\tools\\codex.exe',
    ], os.homedir(), 'win32');

    assert.deepEqual(ordered, [
        'C:\\tools\\codex.exe',
        'C:\\Users\\j\\AppData\\Roaming\\npm\\codex.cmd',
        'C:\\Users\\j\\AppData\\Roaming\\npm\\codex.ps1',
        'C:\\Users\\j\\AppData\\Roaming\\npm\\codex',
    ]);
});

test('windows ranking is stable for equal ranks', () => {
    const ordered = prioritizeCliCandidates('codex', [
        'C:\\b\\codex.cmd',
        'C:\\a\\codex.cmd',
    ], os.homedir(), 'win32');
    // First-seen order preserved within a rank: PATH precedence still wins.
    assert.deepEqual(ordered, ['C:\\b\\codex.cmd', 'C:\\a\\codex.cmd']);
});

test('posix ranking is unchanged when platform is not win32', () => {
    const candidates = ['/usr/local/bin/codex', '/home/j/.bun/bin/codex'];
    assert.deepEqual(
        prioritizeCliCandidates('codex', candidates, '/home/j', 'linux'),
        ['/usr/local/bin/codex', '/home/j/.bun/bin/codex'],
    );
});

test('detection env carries exactly one PATH casing', () => {
    const env = buildCliDetectionEnv('/seed', { PATH: '/a', Path: '/b', path: '/c' });
    const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
    assert.equal(pathKeys.length, 1);
});

/**
 * Real-discovery assertions. These run only on a genuine win32 host, where
 * `where.exe` and the npm shim layout actually exist — everything above uses
 * injected fixtures and proves the same thing on every OS.
 *
 * The pre-existing cli-detect.test.ts is deliberately NOT part of the Windows
 * CI lane: its fixtures depend on the POSIX executable bit (chmod), which
 * Windows does not have, so those cases are POSIX-only by construction.
 */
const onWindows = process.platform === 'win32' ? test : test.skip;

onWindows('where.exe discovery returns launchable candidates for node', () => {
    const scan = listCliBinaryCandidates('node');
    assert.ok(scan.candidates.length > 0, 'node must be discoverable on a Windows runner');

    for (const candidate of scan.candidates) {
        assert.match(candidate.path, /^[A-Za-z]:\\|^\\\\/, 'where.exe must return absolute Windows paths');
    }

    // At least one discovered candidate must actually be launchable.
    assert.ok(
        scan.candidates.some((candidate) => candidate.spawnable),
        `no spawnable node candidate among: ${scan.candidates.map((c) => `${c.path} (${c.reason ?? 'ok'})`).join(', ')}`,
    );
});

onWindows('a discovered npm shim survives the spawnability rules', () => {
    const scan = listCliBinaryCandidates('npm');
    assert.ok(scan.candidates.length > 0, 'npm must be discoverable on a Windows runner');
    const spawnable = scan.candidates.filter((candidate) => candidate.spawnable);
    assert.ok(
        spawnable.length > 0,
        'the npm .cmd shim must remain detectable after the win32 tightening',
    );
});
// Bun ships on Windows under %USERPROFILE%\.bun\bin, so provenance must keep
// outranking extension: a bun .exe must not shadow an npm .cmd.
//
// Paths use the HOST separator on purpose. The provenance helpers compare via
// path.join/path.relative, which are POSIX-flavored when these tests run on
// macOS/Linux and win32-flavored on a real Windows runner. Using host-native
// paths exercises the ranking composition on every OS; the Windows CI lane
// runs the same assertions against genuine backslash paths.
const HOME = path.join(os.tmpdir(), 'jaw-home-fixture');

test('a bun shim stays behind other installs on Windows', () => {
    const bun = path.join(HOME, '.bun', 'bin', 'codex.exe');
    const npm = path.join(HOME, '.npm-global', 'bin', 'codex.cmd');

    assert.deepEqual(
        prioritizeCliCandidates('codex', [bun, npm], HOME, 'win32'),
        [npm, bun],
        'a bun .exe must not outrank a managed-node .cmd',
    );
});

test('extension rank still applies within one provenance bucket on Windows', () => {
    const shim = path.join(HOME, '.npm-global', 'bin', 'codex');
    const exe = path.join(HOME, '.npm-global', 'bin', 'codex.exe');

    assert.deepEqual(
        prioritizeCliCandidates('codex', [shim, exe], HOME, 'win32'),
        [exe, shim],
    );
});

test('a CLI outside the bun-deprioritized set ranks purely by extension', () => {
    const shim = path.join(HOME, '.bun', 'bin', 'gemini');
    const cmd = path.join(HOME, '.bun', 'bin', 'gemini.cmd');

    assert.deepEqual(
        prioritizeCliCandidates('gemini', [shim, cmd], HOME, 'win32'),
        [cmd, shim],
    );
});
