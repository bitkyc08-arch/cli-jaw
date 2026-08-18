import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 as pathWin32 } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
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
    // TRANSITIONAL (020 stage 1). This asserts the compatibility fallback still exists.
    // Stage 2 removes that fallback once the native Windows gate proves every classified
    // runtime resolves — and this test must be deleted as part of that change, not left
    // to quietly pin the insecure path in place.
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

test('WLS-018 (source-shape, pending behavioral replacement): codex resume prompt is not in argv', () => {
    // NOTE: this inspects source text. It cannot prove the prompt BYTES reach stdin or
    // that stdin closes correctly — 020 tracks replacing it with an injected spawn test
    // that captures argv and stdin. Do not cite it as behavioral evidence.
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
    //
    // The outer and nested targets MUST be distinct paths. An earlier version of this
    // test used one path for both, so the second object key silently overwrote the
    // first, `which('tool')` was never called, and the test passed without exercising
    // recursion at all — a false positive.
    const outerShim = 'C:\\npm\\outer.cmd';
    const outerTarget = pathWin32.resolve('C:\\npm', 'node_modules\\outer\\entry.js');
    const toolShim = 'C:\\npm\\tool.cmd';
    const toolTarget = pathWin32.resolve('C:\\npm', 'node_modules\\tool\\entry.js');
    const outerShimBody = REAL_NODE_SHIM.replace('node_modules\\pkg\\entry.js', 'node_modules\\outer\\entry.js');
    const toolShimBody = REAL_NODE_SHIM.replace('node_modules\\pkg\\entry.js', 'node_modules\\tool\\entry.js');
    const files = {
        [outerShim]: outerShimBody,
        [outerTarget]: '#!/usr/bin/env tool\n',
        [toolShim]: toolShimBody,
        [toolTarget]: '#!/usr/bin/env node\n',
    };
    const discovered: string[] = [];
    const spec = resolveWindowsLaunchSpec(outerShim, ['go'], {
        readFile: (p: string) => { const f = files[p]; if (f === undefined) throw new Error('ENOENT'); return f; },
        exists: (p: string) => files[p] !== undefined,
        which: (cmd: string) => {
            discovered.push(cmd);
            if (cmd === 'tool') return toolShim;
            if (cmd === 'node') return 'C:\\Program Files\\nodejs\\node.exe';
            return null;
        },
    });
    assert.ok(spec, 'a bare interpreter resolving to a shim must still resolve');
    // Prove the recursion actually happened rather than inferring it from the result.
    assert.ok(discovered.includes('tool'), 'the bare interpreter must go through discovery');
    assert.equal(spec!.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(spec!.useShell, false);
    // Exact nested ordering: the tool's own script, then the outer target, then argv.
    assert.deepEqual(launchArgv(spec!), [toolTarget, outerTarget, 'go']);
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

test('WLS-021: only real executables are treated as directly launchable', () => {
    const deps = fixtureDeps({});
    // .exe/.com are launchable by CreateProcess with no interpreter.
    assert.equal(resolveWindowsLaunchSpec('C:\\t\\a.exe', [], deps)!.resolvedVia, 'direct');
    assert.equal(resolveWindowsLaunchSpec('C:\\t\\a.com', [], deps)!.resolvedVia, 'direct');
    // Everything else needs an interpreter we have not resolved. Claiming 'direct'
    // here would fail at spawn AND skip the staged compatibility fallback.
    for (const bad of ['a.ps1', 'a.js', 'a.vbs', 'a.sh', 'a.wrapper']) {
        assert.equal(
            resolveWindowsLaunchSpec('C:\\t\\' + bad, [], deps), null,
            bad + ' must not be reported as directly launchable',
        );
    }
});

test('WLS-022: the recursion bound fails closed on a shim chain', () => {
    // 'resolved once, then fail closed' — a three-deep chain (or a cycle) must not be
    // chased. Without a bound this is an unbounded read loop on hostile input.
    const mk = (name: string) => 'C:\\npm\\' + name + '.cmd';
    const tgt = (name: string) => pathWin32.resolve('C:\\npm', 'node_modules\\' + name + '\\entry.js');
    const body = (name: string) => REAL_NODE_SHIM.replace('node_modules\\pkg\\entry.js', 'node_modules\\' + name + '\\entry.js');
    const files: Record<string, string> = {
        [mk('a')]: body('a'), [tgt('a')]: '#!/usr/bin/env b\n',
        [mk('b')]: body('b'), [tgt('b')]: '#!/usr/bin/env c\n',
        [mk('c')]: body('c'), [tgt('c')]: '#!/usr/bin/env node\n',
    };
    const spec = resolveWindowsLaunchSpec(mk('a'), [], {
        readFile: (p: string) => { const f = files[p]; if (f === undefined) throw new Error('ENOENT'); return f; },
        exists: (p: string) => files[p] !== undefined,
        which: (cmd: string) => (files[mk(cmd)] ? mk(cmd) : (cmd === 'node' ? 'C:\\node.exe' : null)),
    });
    assert.equal(spec, null, 'a chain deeper than the bound must fail closed');
});

test('WLS-023: a self-referential shim cycle terminates', () => {
    const shim = 'C:\\npm\\loop.cmd';
    const target = pathWin32.resolve('C:\\npm', 'node_modules\\pkg\\entry.js');
    const files = { [shim]: REAL_NODE_SHIM, [target]: '#!/usr/bin/env loop\n' };
    const spec = resolveWindowsLaunchSpec(shim, [], {
        readFile: (p: string) => { const f = files[p]; if (f === undefined) throw new Error('ENOENT'); return f; },
        exists: (p: string) => files[p] !== undefined,
        which: (cmd: string) => (cmd === 'loop' ? shim : null),
    });
    assert.equal(spec, null);
});

test('WLS-024: no source file may enable a Windows shell without a failed resolution', () => {
    // DISCOVERED, not listed. A hardcoded file list is the wrong oracle: a reviewer
    // found src/cli/cli-status-worker.ts had a live shell spawn the list simply did
    // not name, so the guard read green while the gap was real. Walk the tree, and
    // the next new spawn site is covered the day it lands.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.ts')) continue;
            const src = readFileSync(full, 'utf8');
            const rel = full.slice(full.indexOf('/src/') + 1);
            // Strip comments, then normalize whitespace so a value split across
            // lines reads the same as an inline one.
            const code = src
                .split('\n')
                .filter(l => !/^\s*(\*|\/\/)/.test(l))
                .join('\n')
                .replace(/\s+/g, ' ');
            for (const match of code.matchAll(/shell\s*:\s*([^,}]+)/g)) {
                const value = match[1]!.trim();
                if (value === 'false') continue;
                // A TYPE annotation ('shell: WindowsShellKind') is not a spawn option.
                if (!/^(true|false|1|0)$/.test(value) && !/[?!&|.]/.test(value)) continue;
                // The idiom is `...(guard ? { shell: true } : {})`, so the guard lives
                // BEFORE the literal. Read the enclosing expression, not the literal.
                // 160 chars was too tight: 'windowsSpawnUsesShell ? { shell: true }'
                // sits further from the literal once the options object is spread across
                // several properties. Read the whole enclosing spawn call.
                const context = code.slice(Math.max(0, match.index! - 400), match.index!);
                // Case-insensitive: the guard is spelled windowsSpawnUsesShell here and
                // useShell elsewhere, and a case-sensitive match silently missed one.
                if (/spec|windowslaunch|usesshell|useshell|iscmdshim|launch\.|platform/i.test(context + value)) continue;
                offenders.push(`${rel}: shell: ${value.slice(0, 60)}`);
            }
        }
    };
    walk(join(__dirname, '../../src'));
    assert.deepEqual(offenders, [], 'every Windows shell must be gated on resolution failing');
});

test('WLS-025: every shell guard consults the resolver and is never always-true', () => {
    // Two escapes this closes: a guard that checks only the extension (ignoring the
    // resolver entirely), and one short-circuited with '|| true', which a token
    // search accepts because the resolver name is still present elsewhere.
    const files = ['src/agent/spawn.ts', 'src/agent/pi-runtime.ts', 'src/agent/codex-app-client.ts',
        'src/cli/capability-probe-worker.ts', 'src/cli/cli-status-worker.ts'];
    for (const file of files) {
        const src = readFileSync(join(__dirname, '../../', file), 'utf8');
        assert.match(src, /resolveWindowsLaunchSpec|resolvePiSpawn/, file + ' must consult the resolver');
        const flat = src
            .split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n')
            .replace(/\s+/g, ' ');
        const guards: string[] = [];
        for (const m of flat.matchAll(/const (?:useShell|isCmdShim|windowsSpawnUsesShell)\s*=\s*([^;]+);/g)) {
            guards.push(m[1]!);
        }
        for (const m of flat.matchAll(/shell\s*:\s*([^,}]+)/g)) {
            const value = m[1]!.trim();
            if (value === 'true' || value === 'false') continue;   // literal inside a guarded spread
            if (!/[?!&|.]/.test(value)) continue;                   // a type annotation
            guards.push(value);
        }
        for (const guard of guards) {
            assert.doesNotMatch(guard, /(\|\|\s*true\b|\btrue\s*\|\|)/, file + ': guard is always true — ' + guard.trim());
            assert.match(
                guard, /!\s*(spec|launchSpec|windowsLaunch)|launch\./,
                file + ': guard ignores the resolver result — ' + guard.trim(),
            );
        }
    }
});

test('WLS-026: resolved env assignments reach the child at every migrated site', () => {
    // envDelta carries `env -S FOO=bar` from the target's shebang. Dropping it runs
    // the runtime with a different configuration than its own shim asks for — a
    // silent misconfiguration rather than a visible failure.
    const sites: Array<[string, RegExp]> = [
        ['src/agent/spawn.ts', /windowsLaunch\.envDelta/],
        // #382: envDelta now flows through mergeEnvWindowsSafe instead of a
        // bare spread, so assert the delta reaches the merge call.
        ['src/agent/pi-runtime.ts', /mergeEnvWindowsSafe\([^)]*launch\.envDelta\)/],
        ['src/agent/codex-app-client.ts', /launchSpec\.envDelta/],
        ['src/cli/capability-probe-worker.ts', /spec\.envDelta/],
        ['src/cli/cli-status-worker.ts', /spec\.envDelta/],
    ];
    for (const [file, pattern] of sites) {
        const src = readFileSync(join(__dirname, '../../', file), 'utf8');
        assert.match(src, pattern, `${file} must merge envDelta into the child env`);
    }
});
