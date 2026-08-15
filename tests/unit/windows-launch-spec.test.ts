import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 as pathWin32 } from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
import {
    extractCmdShimTarget,
    parseShebang,
    resolveWindowsLaunchSpec,
    launchArgv,
} from '../../src/core/windows-launch-spec.ts';

/**
 * Fixtures below are the VERBATIM output of npm's own cmd-shim (v7, as installed with
 * npm 11) — not hand-written approximations. A fixture written to match our parser
 * would only prove the fixture generator, and the real format is exactly where the
 * first draft of this resolver went wrong: real shims wrap the call in an
 * _prog/endLocal structure, not a bare `node "..." %*` line.
 */
const REAL_NODE_SHIM = [
    '@ECHO off\r',
    'GOTO start\r',
    ':find_dp0\r',
    'SET dp0=%~dp0\r',
    'EXIT /b\r',
    ':start\r',
    'SETLOCAL\r',
    'CALL :find_dp0\r',
    '\r',
    'IF EXIST "%dp0%\\node.exe" (\r',
    '  SET "_prog=%dp0%\\node.exe"\r',
    ') ELSE (\r',
    '  SET "_prog=node"\r',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%\r',
    ')\r',
    '\r',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\entry.js" %*\r',
].join('\n');

const REAL_LOCAL_SHIM = REAL_NODE_SHIM.replace(
    '%dp0%\\node_modules\\pkg\\entry.js',
    '%dp0%\\..\\pkg\\entry.js',
);

test('WLS-001: extracts the target from a REAL npm cmd-shim (global layout)', () => {
    assert.equal(extractCmdShimTarget(REAL_NODE_SHIM), 'node_modules\\pkg\\entry.js');
});

test('WLS-002: extracts the target from a REAL npm cmd-shim (local layout)', () => {
    assert.equal(extractCmdShimTarget(REAL_LOCAL_SHIM), '..\\pkg\\entry.js');
});

test('WLS-003: a non-shim body yields null rather than a guess', () => {
    assert.equal(extractCmdShimTarget('@echo off\r\nsomething-else.exe %*\r\n'), null);
    assert.equal(extractCmdShimTarget(''), null);
});

test('WLS-004: parses plain and env-based shebangs', () => {
    assert.deepEqual(parseShebang('#!/usr/bin/env node\nx'), {
        interpreter: 'node', args: [], envDelta: {},
    });
    // Observed in a real install: claude-e is sh, cursor-agent is bash. Assuming node
    // here would launch a shell script with the wrong interpreter.
    assert.deepEqual(parseShebang('#!/usr/bin/env sh\nset -eu'), {
        interpreter: 'sh', args: [], envDelta: {},
    });
    assert.deepEqual(parseShebang('#!/bin/bash -e\n'), {
        interpreter: '/bin/bash', args: ['-e'], envDelta: {},
    });
});

test('WLS-005: parses env -S with variable assignments and interpreter args', () => {
    assert.deepEqual(parseShebang('#!/usr/bin/env -S FOO=bar node --enable-source-maps\n'), {
        interpreter: 'node',
        args: ['--enable-source-maps'],
        envDelta: { FOO: 'bar' },
    });
});

test('WLS-006: a missing shebang is null', () => {
    assert.equal(parseShebang('console.log(1)\n'), null);
});

function fixtureDeps(files: Record<string, string>) {
    return {
        readFile: (p: string) => {
            const found = files[p];
            if (found === undefined) throw new Error('ENOENT ' + p);
            return found;
        },
        exists: (p: string) => files[p] !== undefined,
    };
}

test('WLS-007: a real Node shim resolves to node + target, never a shell', () => {
    const shim = 'C:\\Users\\jun\\AppData\\Roaming\\npm\\foo.cmd';
    const target = pathWin32.resolve(pathWin32.dirname(shim), 'node_modules\\pkg\\entry.js');
    const spec = resolveWindowsLaunchSpec(shim, ['--flag', 'prompt & echo hi'], fixtureDeps({
        [shim]: REAL_NODE_SHIM,
        [target]: '#!/usr/bin/env node\nconsole.log(1)\n',
    }));
    assert.ok(spec, 'a real npm shim must resolve');
    assert.equal(spec!.resolvedVia, 'shim-target');
    assert.equal(spec!.command, 'node');
    assert.equal(spec!.target, target);
    assert.equal(spec!.useShell, false);
    // Ordering matters: interpreter args, then the script, then the caller's argv.
    assert.deepEqual(launchArgv(spec!), [target, '--flag', 'prompt & echo hi']);
});

test('WLS-008: a shell-script shim resolves to sh, not node', () => {
    const shim = 'C:\\npm\\shy.cmd';
    const target = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const spec = resolveWindowsLaunchSpec(shim, ['go'], fixtureDeps({
        [shim]: REAL_NODE_SHIM,
        [target]: '#!/usr/bin/env sh\nset -eu\n',
    }));
    assert.equal(spec!.command, 'sh');
    assert.deepEqual(launchArgv(spec!), [target, 'go']);
});

test('WLS-009: env -S assignments survive into envDelta', () => {
    const shim = 'C:\\npm\\envy.cmd';
    const target = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const spec = resolveWindowsLaunchSpec(shim, [], fixtureDeps({
        [shim]: REAL_NODE_SHIM,
        [target]: '#!/usr/bin/env -S FOO=bar node --enable-source-maps\n',
    }));
    assert.deepEqual(spec!.envDelta, { FOO: 'bar' });
    assert.deepEqual(launchArgv(spec!), ['--enable-source-maps', target]);
});

test('WLS-010: a native executable is direct, with no target', () => {
    const spec = resolveWindowsLaunchSpec('C:\\tools\\grok.exe', ['ask'], fixtureDeps({}));
    assert.equal(spec!.resolvedVia, 'direct');
    assert.equal(spec!.target, null);
    assert.equal(spec!.useShell, false);
    assert.deepEqual(launchArgv(spec!), ['ask']);
});

test('WLS-011: an unresolvable shim fails closed instead of falling back to a shell', () => {
    const shim = 'C:\\npm\\weird.cmd';
    // A vendor wrapper we do not understand. Returning null is the point: silently
    // re-enabling shell:true here would reintroduce exactly the #367 defect.
    assert.equal(resolveWindowsLaunchSpec(shim, [], fixtureDeps({
        [shim]: '@echo off\r\nvendor-magic.exe %*\r\n',
    })), null);

    // Target named by the shim but absent on disk.
    assert.equal(resolveWindowsLaunchSpec(shim, [], fixtureDeps({
        [shim]: REAL_NODE_SHIM,
    })), null);

    // Target present but with no shebang to identify an interpreter.
    const target = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    assert.equal(resolveWindowsLaunchSpec(shim, [], fixtureDeps({
        [shim]: REAL_NODE_SHIM,
        [target]: 'no shebang here\n',
    })), null);
});

test('WLS-012: user argv is never re-parsed, whatever it contains', () => {
    const shim = 'C:\\npm\\foo.cmd';
    const target = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const hostile = '& echo INJECTED > sentinel.txt | "quoted\\" %PATH% !VALUE! 한글 😀';
    const spec = resolveWindowsLaunchSpec(shim, [hostile], fixtureDeps({
        [shim]: REAL_NODE_SHIM,
        [target]: '#!/usr/bin/env node\n',
    }));
    assert.deepEqual(spec!.userArgs, [hostile]);
    assert.equal(launchArgv(spec!).at(-1), hostile);
});

test('WLS-013: the spawn path prefers shell-free resolution over shell:true', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    // windowsSpawnUsesShell must be gated on resolution FAILING. If the resolver
    // returns a spec, a shell must never be added to the same spawn.
    assert.match(spawnSrc, /windowsSpawnUsesShell = process\.platform === 'win32'\s*\n\s*&& !windowsLaunch/);
    assert.match(spawnSrc, /spawn\(launchCommand, launchArgs, \{/);
});
