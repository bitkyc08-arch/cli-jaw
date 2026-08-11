import test from 'node:test';
import assert from 'node:assert/strict';
import { __setToolEnvironment, runInstallCmd } from '../../bin/postinstall.ts';

// Behavior cover for #274. execName() alone proves the mapping; this proves the
// install path actually GOES THROUGH it. The fake adapter sits BELOW name
// resolution on purpose — a fake that replaced the whole runner would only ever
// observe the pre-resolution name and could not catch a call site that skipped
// the seam.

function record(platform: NodeJS.Platform) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const restore = __setToolEnvironment((file, args) => {
        calls.push({ file, args });
        return '';
    }, platform);
    return { calls, restore };
}

test('#274: npm install on win32 spawns npm.cmd, never bare npm', () => {
    const { calls, restore } = record('win32');
    try {
        runInstallCmd('npm', 'some-package', {});
    } finally {
        restore();
    }
    assert.equal(calls.length, 1);
    // Not just the renamed shim: a .cmd needs the cmd.exe wrapper, because
    // Node will not execFile a batch script directly.
    assert.match(calls[0]!.file, /cmd\.exe$/);
    assert.deepEqual(calls[0]!.args, ['/d', '/s', '/c', 'npm.cmd', 'i', '-g', 'some-package@latest']);
});

test('npm install on posix still spawns bare npm', () => {
    const { calls, restore } = record('darwin');
    try {
        runInstallCmd('npm', 'some-package', {});
    } finally {
        restore();
    }
    assert.equal(calls[0]!.file, 'npm');
});

test('bun is not rewritten on win32', () => {
    const { calls, restore } = record('win32');
    try {
        runInstallCmd('bun', 'some-package', {});
    } finally {
        restore();
    }
    assert.equal(calls[0]!.file, 'bun');
});

test('brew keeps its upgrade-then-install fallback, which relies on throw', () => {
    // The seam must not convert failures into return values: this path depends
    // on `upgrade` throwing so `install` runs.
    const calls: string[] = [];
    const restore = __setToolEnvironment((file, args) => {
        calls.push(`${file} ${args[0]}`);
        if (args[0] === 'upgrade') throw new Error('not installed');
        return '';
    }, 'darwin');
    try {
        runInstallCmd('brew', 'some-package', {});
    } finally {
        restore();
    }
    assert.deepEqual(calls, ['brew upgrade', 'brew install']);
});

test('the seam restores the previous adapter', () => {
    const first = record('win32');
    const second = record('darwin');
    second.restore();
    try {
        runInstallCmd('npm', 'pkg', {});
        assert.match(first.calls[0]!.file, /cmd\.exe$/, 'inner restore must return to the outer win32 seam');
    } finally {
        first.restore();
    }
});
