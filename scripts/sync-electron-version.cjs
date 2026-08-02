#!/usr/bin/env node
/**
 * Keep electron/package.json's version equal to the root package.json's.
 *
 * Without this the two drifted freely: the root reached 2.2.7 while the
 * Electron shell sat at 0.1.0 since its first commit, so every desktop release
 * produced identically-named artifacts (cli-jaw-0.1.0-arm64.dmg) and the file
 * you downloaded told you nothing about which release it came from.
 *
 * Why the version has to be COMMITTED rather than injected at build time:
 * electron-builder's default artifact name is `${productName}-${version}-...`
 * resolved from the packaged app's own package.json, and
 * .github/workflows/desktop-release.yml builds from a release-tag checkout. A
 * build-time flag would work on a developer machine and silently do nothing in
 * the workflow that actually publishes the assets.
 *
 * One implementation serves both the writer and the gate on purpose. A gate
 * that computed the expected value separately could pass while the release
 * wrote something else.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = join(__dirname, '..');
const electronDir = join(repoRoot, 'electron');

/** Version field of the package.json in `dir`. */
function readVersion(dir) {
    const file = join(dir, 'package.json');
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(`cannot read ${file}: ${error.message}`);
    }
    try {
        return JSON.parse(raw).version;
    } catch (error) {
        throw new Error(`${file} is not valid JSON: ${error.message}`);
    }
}

function main() {
    let rootVersion;
    let electronVersion;
    try {
        rootVersion = readVersion(repoRoot);
        electronVersion = readVersion(electronDir);
    } catch (error) {
        // Fails closed either way -- an unreadable manifest already exited
        // non-zero via the uncaught throw. What this adds is a first line the
        // reader can act on instead of a Node stack trace.
        console.error(`ERROR: ${error.message}`);
        return 1;
    }
    const check = process.argv.includes('--check');

    if (electronVersion === rootVersion) {
        console.log(`[electron-version] OK ${rootVersion}`);
        return 0;
    }

    if (check) {
        // Name both values. "versions differ" leaves the reader guessing which
        // side is authoritative.
        console.error(
            `ERROR: electron/package.json version ${electronVersion} != root package.json ${rootVersion}`);
        console.error('Run: npm run sync:electron-version');
        return 1;
    }

    // Delegate to npm instead of editing JSON by hand: `npm version` updates
    // package.json and the root entries of package-lock.json together. Writing
    // both files directly means reimplementing the lockfile's shape, and
    // getting it subtly wrong surfaces later as unexplained churn in someone
    // else's dependency diff.
    const result = spawnSync(
        'npm',
        ['version', rootVersion, '--no-git-tag-version', '--allow-same-version'],
        { cwd: electronDir, encoding: 'utf8', timeout: 60_000 },
    );
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        console.error(`ERROR: npm version failed in electron/: ${detail}`);
        return 1;
    }

    console.log(`[electron-version] synced ${electronVersion} -> ${rootVersion}`);
    return 0;
}

process.exit(main());
