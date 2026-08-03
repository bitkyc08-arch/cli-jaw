// node-gyp's bundled gyp imports stdlib `distutils`, removed in Python 3.12
// (PEP 632). On a machine whose default python3 is 3.12+ the native rebuild of
// node-pty dies during desktop packaging. CI already pins 3.11 for this reason;
// the local `electron:dist:mac` path had no equivalent until this script.
//
// These tests RUN the picker against synthetic candidates rather than asserting
// on its source, because the failure mode is "it chose an interpreter that
// cannot import distutils" -- a claim only execution can settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const picker = join(projectRoot, 'scripts', 'pick-gyp-python.sh');

const run = (env: NodeJS.ProcessEnv = {}) =>
    spawnSync('bash', [picker], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, ...env },
    });

/** A fake python3 that either has distutils or does not. */
function fakePython(dir: string, name: string, hasDistutils: boolean): string {
    const path = join(dir, name);
    writeFileSync(path, hasDistutils
        ? '#!/bin/sh\nexit 0\n'
        : '#!/bin/sh\necho "ModuleNotFoundError: No module named \'distutils\'" >&2\nexit 1\n');
    chmodSync(path, 0o755);
    return path;
}

test('picks an interpreter that can actually import distutils', () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const picked = result.stdout.trim();
    assert.ok(picked.length > 0, 'the picker printed nothing');

    // The whole point: whatever it chose must survive the import node-gyp does.
    const probe = spawnSync(picked, ['-c', 'import distutils'], {
        encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(probe.status, 0,
        `picked ${picked}, but it cannot import distutils: ${probe.stderr}`);
});

test('an explicit PYTHON wins', () => {
    // The caller may know something the search does not -- a pyenv shim, a
    // container path. Overriding must not be second-guessed.
    const result = run({ PYTHON: '/opt/deliberate/python3' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '/opt/deliberate/python3');
});

test('skips a python3 that lacks distutils and keeps looking', () => {
    // This is the real-world shape: Homebrew python3 first on PATH at 3.14,
    // a usable interpreter further down. Verified against a machine where
    // `python3 --version` said 3.14.6 and the picker returned /usr/bin/python3.
    const dir = mkdtempSync(join(tmpdir(), 'gyp-python-'));
    try {
        fakePython(dir, 'python3', false);
        const good = fakePython(dir, 'python3.11', true);

        const result = run({ PATH: `${dir}:/usr/bin:/bin`, PYTHON: '' });
        assert.equal(result.status, 0, result.stderr);

        const picked = result.stdout.trim();
        assert.notEqual(picked, join(dir, 'python3'),
            'the picker chose the interpreter without distutils');
        assert.ok(picked === good || picked === '/usr/bin/python3',
            `expected a distutils-capable interpreter, got ${picked}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('warns instead of failing silently when nothing has distutils', () => {
    // Failing closed here would block a build node-gyp might still manage;
    // failing silently would produce a confusing gyp traceback. It prints the
    // fallback and explains the likely failure.
    //
    // Driving this on a real macOS box is awkward: the script probes the
    // hardcoded /usr/bin/python3, which genuinely has distutils, so the
    // "nothing works" branch is unreachable without either faking that path or
    // adding a test-only hook to the script. Neither is worth it -- a hook
    // would put test scaffolding in a build script to exercise its own
    // fallback. Instead run a copy whose system candidate points at a broken
    // shim, which tests the same logic without touching the shipped file.
    const dir = mkdtempSync(join(tmpdir(), 'gyp-python-none-'));
    try {
        const broken = fakePython(dir, 'python3', false);
        const copy = join(dir, 'pick-copy.sh');
        const source = readFileSync(picker, 'utf8');
        const rewritten = source.replace('  /usr/bin/python3 \\', `  ${broken} \\`);
        // Without this the test rots silently: reformat the candidate list and
        // the replacement stops matching, the copy keeps probing the real
        // /usr/bin/python3, and the assertions below pass for the wrong reason
        // on any machine where that interpreter works.
        assert.notEqual(rewritten, source,
            'the system-candidate line moved; this test is no longer redirecting it');
        writeFileSync(copy, rewritten);

        const result = spawnSync('bash', [copy], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 30_000,
            // dir first so every python3.N lookup also lands on a broken shim.
            env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, PYTHON: '' },
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), broken);
        assert.match(result.stderr, /no python3 with distutils found/);
        assert.match(result.stderr, /set PYTHON=/, 'the warning must name the escape hatch');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('every electron-builder entrypoint routes node-gyp through the picker', () => {
    // The first version of this fix wrapped only the mac path in the root
    // package.json, which left `npm --prefix electron run dist:win` and friends
    // reaching electron-builder with whatever python3 was on PATH. The wrapper
    // belongs on the scripts that actually invoke electron-builder.
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'electron', 'package.json'), 'utf8')) as
        { scripts: Record<string, string> };

    const builderScripts = Object.entries(pkg.scripts)
        .filter(([, body]) => body.includes('electron-builder'));
    assert.ok(builderScripts.length >= 4,
        `expected several electron-builder scripts, found ${builderScripts.length}`);

    for (const [name, body] of builderScripts) {
        assert.match(body, /pick-gyp-python\.sh/,
            `${name} calls electron-builder without resolving a node-gyp-capable python`);
        assert.match(body, /npm_config_python=/,
            `${name} must set npm_config_python; node-gyp does not read PYTHON alone`);
    }
});
