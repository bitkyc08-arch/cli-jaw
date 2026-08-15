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
        // Interpreters named in a shebang are bare names too, so they go through the
        // same discovery as a bare top-level command. A test that omits this is
        // asserting the undiscoverable case.
        which: (cmd: string) => {
            const known: Record<string, string> = {
                node: 'C:\\Program Files\\nodejs\\node.exe',
                sh: 'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
                bash: 'C:\\Program Files\\Git\\bin\\bash.exe',
            };
            return known[cmd] ?? null;
        },
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
    assert.equal(spec!.command, 'C:\\Program Files\\nodejs\\node.exe');
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
    assert.equal(spec!.command, 'C:\\Program Files\\Git\\usr\\bin\\sh.exe');
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

test('WLS-014: a bare name is resolved through PATHEXT discovery before deciding', () => {
    // The dangerous case: 'copilot' has no extension, so treating it as direct would
    // skip shim resolution and let Windows resolve it to copilot.cmd through PATHEXT —
    // under a shell, which is exactly the #367 defect.
    const shim = 'C:\\npm\\copilot.cmd';
    const target = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const deps = {
        ...fixtureDeps({ [shim]: REAL_NODE_SHIM, [target]: '#!/usr/bin/env node\n' }),
        which: (cmd: string) => {
            if (cmd === 'copilot') return shim;
            if (cmd === 'node') return 'C:\\Program Files\\nodejs\\node.exe';
            return null;
        },
    };
    const spec = resolveWindowsLaunchSpec('copilot', ['ask'], deps);
    assert.equal(spec!.resolvedVia, 'shim-target');
    assert.equal(spec!.useShell, false);
});

test('WLS-015: a bare name resolving to a real executable stays direct', () => {
    const deps = {
        ...fixtureDeps({}),
        which: (cmd: string) => (cmd === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : null),
    };
    const spec = resolveWindowsLaunchSpec('node', ['-v'], deps);
    assert.equal(spec!.resolvedVia, 'direct');
    assert.equal(spec!.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(spec!.target, null);
});

test('WLS-016: an unresolvable bare name fails closed rather than launching blind', () => {
    // Without discovery we cannot prove PATHEXT will not select a .cmd at spawn time,
    // so 'probably an exe' is not good enough.
    const deps = { ...fixtureDeps({}), which: () => null };
    assert.equal(resolveWindowsLaunchSpec('mystery', [], deps), null);
    assert.equal(resolveWindowsLaunchSpec('mystery', [], fixtureDeps({})), null);
});

test('WLS-017: shebang quoting beyond the supported grammar fails closed', () => {
    // A naive whitespace split would turn these into wrong arguments. Refusing is
    // safer than guessing, and the caller reports an unsupported shim.
    assert.equal(parseShebang('#!/usr/bin/env -S NAME="two words" node\n'), null);
    assert.equal(parseShebang('#!/usr/bin/env -S FOO=a\\ b node\n'), null);
    // The supported shapes still parse.
    assert.equal(parseShebang('#!/usr/bin/env node\n')!.interpreter, 'node');
});

test('WLS-018: codex resume carries the prompt on stdin, not argv', () => {
    const argsSrc = readFileSync(join(__dirname, '../../src/agent/args.ts'), 'utf8');
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    // Fresh and resume must have identical guarantees. Resume previously placed the
    // same untrusted prompt in argv, where a .cmd shim would expose it to cmd.exe.
    assert.match(argsSrc, /sessionId, '-', '--json'/);
    assert.doesNotMatch(argsSrc, /sessionId, prompt \|\| '', '--json'/);
    assert.match(spawnSrc, /cli === 'codex' && isResume/);
});

test('WLS-019: a BARE shebang interpreter is discovered, not trusted', () => {
    // The same hole as WLS-014, one level down: `#!/usr/bin/env tool` where tool
    // resolves through PATHEXT to tool.cmd would otherwise skip inspection.
    const outerShim = 'C:\\npm\\outer.cmd';
    const outerTarget = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const toolShim = 'C:\\npm\\tool.cmd';
    const toolTarget = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const files = {
        [outerShim]: REAL_NODE_SHIM,
        [outerTarget]: '#!/usr/bin/env tool\n',
        [toolShim]: REAL_NODE_SHIM,
        [toolTarget]: '#!/usr/bin/env node\n',
    };
    const spec = resolveWindowsLaunchSpec(outerShim, ['go'], {
        readFile: (p: string) => { const f = files[p]; if (f === undefined) throw new Error('ENOENT'); return f; },
        exists: (p: string) => files[p] !== undefined,
        which: (cmd: string) => {
            if (cmd === 'tool') return toolShim;
            if (cmd === 'node') return 'C:\\Program Files\\nodejs\\node.exe';
            return null;
        },
    });
    assert.ok(spec, 'a bare interpreter resolving to a shim must still resolve');
    assert.equal(spec!.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(spec!.useShell, false);
});

test('WLS-020: an undiscoverable shebang interpreter fails closed', () => {
    const shim = 'C:\\npm\\foo.cmd';
    const target = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const files = { [shim]: REAL_NODE_SHIM, [target]: '#!/usr/bin/env mystery\n' };
    const spec = resolveWindowsLaunchSpec(shim, [], {
        readFile: (p: string) => { const f = files[p]; if (f === undefined) throw new Error('ENOENT'); return f; },
        exists: (p: string) => files[p] !== undefined,
        which: () => null,
    });
    assert.equal(spec, null);
});
