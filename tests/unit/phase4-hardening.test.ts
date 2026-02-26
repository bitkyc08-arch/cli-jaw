// Phase 4 hardening guards: unknown launchd options, quoted launchctl path, dynamic server URL
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const launchdSrc = readFileSync(join(projectRoot, 'bin/commands/launchd.ts'), 'utf8');
const browserSrc = readFileSync(join(projectRoot, 'bin/commands/browser.ts'), 'utf8');
const memorySrc = readFileSync(join(projectRoot, 'bin/commands/memory.ts'), 'utf8');

test('P4H-001: launchd rejects unknown option (e.g. --dry-run)', () => {
    let err: any = null;
    try {
        execSync('node dist/bin/cli-jaw.js launchd --dry-run', {
            cwd: projectRoot,
            stdio: 'pipe',
            encoding: 'utf8',
        });
    } catch (e) {
        err = e;
    }

    assert.ok(err, 'launchd with unknown option should fail');
    assert.equal(err.status, 1);
    const stderr = String(err.stderr || '');
    assert.match(stderr, /Unknown option/i);
});

test('P4H-002: launchctl load/unload quotes plist path', () => {
    assert.ok(launchdSrc.includes('launchctl unload "${PLIST_PATH}"'));
    assert.ok(launchdSrc.includes('launchctl load -w "${PLIST_PATH}"'));
});

test('P4H-003: browser command uses dynamic server URL (no hardcoded 3457)', () => {
    assert.ok(browserSrc.includes('getServerUrl(undefined)'));
    assert.ok(!browserSrc.includes("getServerUrl('3457')"));
});

test('P4H-004: memory command uses dynamic server URL (no hardcoded 3457)', () => {
    assert.ok(memorySrc.includes('getServerUrl(undefined)'));
    assert.ok(!memorySrc.includes("getServerUrl('3457')"));
});
