import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlatformKind, isWindowsNative, isWsl } from '../../src/core/platform-kind.js';

/**
 * The only suite whose result depends on the real runner OS.
 *
 * The injected-fixture table in platform-kind.test.ts proves the same thing on
 * every platform, because it passes `platform` as an argument. This file calls
 * the resolver with NO arguments, so running it on a Windows runner is what
 * actually upgrades "correct when we say win32" to "correct when the process
 * genuinely is win32".
 *
 * Set JAW_EXPECT_PLATFORM_KIND to make the expectation unconditional. The WSL
 * CI job sets it to `wsl`, so the resolver cannot regress to plain `linux`
 * while the job stays green — without it, a scrubbed WSL_DISTRO_NAME would let
 * the permissive branch below accept either answer.
 */
test('default-argument resolution matches the real host', () => {
    const kind = resolvePlatformKind();
    const expected = process.env['JAW_EXPECT_PLATFORM_KIND'];
    if (expected) {
        assert.equal(kind, expected, `runner expected platform kind ${expected}`);
    }

    if (process.platform === 'win32') {
        assert.equal(kind, 'windows-native');
        assert.equal(isWindowsNative(), true);
        assert.equal(isWsl(), false, 'a native Windows runner must never classify as WSL');
    } else if (process.platform === 'darwin') {
        assert.equal(kind, 'darwin');
        assert.equal(isWindowsNative(), false);
    } else if (process.platform === 'linux') {
        assert.equal(isWindowsNative(), false);
        if (process.env['WSL_DISTRO_NAME']) {
            // The windows-wsl CI job runs here: a real WSL process must say wsl.
            assert.equal(kind, 'wsl', 'a WSL runner must classify as wsl');
        } else {
            assert.ok(kind === 'linux' || kind === 'wsl', `unexpected kind ${kind}`);
        }
    } else {
        assert.equal(kind, 'other');
    }
});
