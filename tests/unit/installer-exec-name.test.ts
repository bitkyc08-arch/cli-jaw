import test from 'node:test';
import assert from 'node:assert/strict';
import { execName } from '../../src/core/exec-name.ts';

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
