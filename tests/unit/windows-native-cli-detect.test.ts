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
} from '../../src/core/cli-detect.js';

function fixtureDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-win-detect-'));
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

test('a custom PATHEXT entry does not make a file spawnable', () => {
    const dir = fixtureDir();
    const pyTool = path.join(dir, 'codex.py');
    fs.writeFileSync(pyTool, 'print(1)\n');
    // Even if .PY is in PATHEXT, ComSpec cannot launch it.
    assert.equal(isSpawnableCliFile(pyTool, 'win32').ok, false);
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
