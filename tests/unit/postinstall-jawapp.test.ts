// P37-POSTINSTALL: ensureJawAppInstall + compileJawLauncher + buildPinnedPath.
// Matches devlog/_plan/computeruse/37_revisions_and_integration.md §A/§A'/§B.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildPinnedPath, compileJawLauncher } from '../../bin/postinstall.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

test('P37-POSTINSTALL-001: buildPinnedPath returns a colon-joined non-empty PATH', () => {
    const pinned = buildPinnedPath();
    assert.ok(pinned.length > 0, 'pinnedPath must not be empty');
    assert.ok(pinned.includes(':'), 'pinnedPath must be colon-delimited');
    // At minimum system bin must be discoverable.
    const dirs = pinned.split(':');
    assert.ok(dirs.some((d) => d === '/usr/bin' || d === '/bin'),
        'pinnedPath must include /usr/bin or /bin');
});

test('P37-POSTINSTALL-002: buildPinnedPath deduplicates entries', () => {
    const pinned = buildPinnedPath();
    const dirs = pinned.split(':').filter((d) => d.length > 0);
    assert.equal(new Set(dirs).size, dirs.length, 'pinnedPath has duplicate entries');
});

test('P37-POSTINSTALL-003: jaw-launcher.m source is present in repo', () => {
    const src = path.join(REPO_ROOT, 'mac-app', 'jaw-launcher.m');
    assert.ok(fs.existsSync(src), 'mac-app/jaw-launcher.m must exist');
    const content = fs.readFileSync(src, 'utf8');
    assert.match(content, /PINNED_PATH/);
    assert.match(content, /NSTask/);
});

test(
    'P37-POSTINSTALL-004: compileJawLauncher produces a Mach-O binary with clang',
    { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/clang') },
    () => {
        const tmp = path.join(os.tmpdir(), `jaw-launcher-test-${process.pid}`);
        try {
            const ok = compileJawLauncher(tmp, '/usr/bin:/bin');
            assert.equal(ok, true, 'compileJawLauncher must succeed when clang is present');
            assert.ok(fs.existsSync(tmp), 'launcher binary must be written to destPath');
            const fileOut = execFileSync('/usr/bin/file', [tmp], { encoding: 'utf8' });
            assert.match(fileOut, /Mach-O/, `not a Mach-O binary: ${fileOut}`);
        } finally {
            try { fs.unlinkSync(tmp); } catch { /* ok */ }
        }
    },
);

test('P37-POSTINSTALL-005: Jaw.app template ships an Info.plist with bundle ID', () => {
    const plistPath = path.join(REPO_ROOT, 'mac-app', 'Jaw.app.template', 'Contents', 'Info.plist');
    assert.ok(fs.existsSync(plistPath), 'Jaw.app template Info.plist must exist');
    const content = fs.readFileSync(plistPath, 'utf8');
    assert.match(content, /<string>com\.cli-jaw\.agent<\/string>/);
    assert.match(content, /NSAppleEventsUsageDescription/);
    assert.match(content, /\{\{CLI_JAW_VERSION\}\}/, 'version placeholder must exist for postinstall substitution');
});
