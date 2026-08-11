import test from 'node:test';
import assert from 'node:assert/strict';
import { execName, launchSpec } from '../../src/core/exec-name.ts';

// Regression cover for #274: `execFileSync('npm', ...)` cannot launch npm.cmd
// on Windows, so every auto-install in `jaw init` failed with a bare ENOENT on
// a host where npm was installed and working.

test('npm resolves to npm.cmd on win32 only', () => {
    assert.equal(execName('npm', 'win32'), 'npm.cmd');
    assert.equal(execName('npm', 'darwin'), 'npm');
    assert.equal(execName('npm', 'linux'), 'npm');
});

test('native Windows executables are left alone', () => {
    // These ship as .exe and resolve from a bare name; rewriting them would
    // break working installs rather than fix anything.
    for (const cmd of ['curl', 'powershell', 'node', 'bun']) {
        assert.equal(execName(cmd, 'win32'), cmd, `${cmd} must not be rewritten`);
    }
});

test('bunx is NOT mapped to bunx.cmd', () => {
    // Bun installs bunx.exe as a hardlink of bun.exe on Windows, so a static
    // .cmd mapping would miss a healthy install.
    assert.equal(execName('bunx', 'win32'), 'bunx');
});

test('an unknown command passes through unchanged', () => {
    assert.equal(execName('some-tool', 'win32'), 'some-tool');
    assert.equal(execName('', 'win32'), '');
});

// The name mapping alone is not enough. A .cmd file is a script interpreted by
// cmd.exe, not an executable image, and since the CVE-2024-27980 hardening Node
// refuses to run one through execFile/spawn without a shell. Resolving `npm` to
// `npm.cmd` and still calling execFileSync only trades ENOENT for EINVAL.

test('#274: win32 npm is launched through cmd.exe, not execFile directly', () => {
    const spec = launchSpec('npm', ['i', '-g', 'pkg'], 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    assert.equal(spec.file, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(spec.args, ['/d', '/s', '/c', 'npm.cmd', 'i', '-g', 'pkg']);
});

test('arguments stay a real argv array — no shell string concatenation', () => {
    // A shell:true fix would have to escape this; passing argv avoids the
    // metacharacter exposure and the DEP0190 warning entirely.
    const spec = launchSpec('npm', ['i', '-g', 'a b & echo hi'], 'win32', {});
    assert.deepEqual(spec.args, ['/d', '/s', '/c', 'npm.cmd', 'i', '-g', 'a b & echo hi']);
});

test('ComSpec is honored, with a documented fallback', () => {
    assert.equal(launchSpec('npm', [], 'win32', { ComSpec: 'D:\\alt\\cmd.exe' }).file, 'D:\\alt\\cmd.exe');
    assert.equal(launchSpec('npm', [], 'win32', { COMSPEC: 'E:\\c.exe' }).file, 'E:\\c.exe');
    assert.equal(launchSpec('npm', [], 'win32', {}).file, 'cmd.exe');
});

test('non-batch Windows executables are launched directly', () => {
    // Wrapping a real .exe in cmd.exe would add a process and break stdio
    // expectations for no benefit.
    for (const cmd of ['curl', 'powershell', 'node', 'bun']) {
        const spec = launchSpec(cmd, ['--version'], 'win32', {});
        assert.equal(spec.file, cmd, `${cmd} must launch directly`);
        assert.deepEqual(spec.args, ['--version']);
    }
});

test('an already-suffixed .cmd/.bat path is also wrapped', () => {
    assert.equal(launchSpec('C:\\tools\\thing.cmd', [], 'win32', {}).file, 'cmd.exe');
    assert.equal(launchSpec('C:\\tools\\thing.BAT', [], 'win32', {}).file, 'cmd.exe');
});

test('posix is the identity — no cmd.exe, no rename', () => {
    const spec = launchSpec('npm', ['i', '-g', 'pkg'], 'darwin', {});
    assert.equal(spec.file, 'npm');
    assert.deepEqual(spec.args, ['i', '-g', 'pkg']);
});
