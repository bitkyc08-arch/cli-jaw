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
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { dirname } = require('node:path');
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

/**
 * Resolve npm as [bin, ...baseArgs] runnable via spawnSync WITHOUT a shell.
 * On Windows the bare name 'npm' is npm.cmd, and Node's spawnSync refuses to
 * run .cmd/.bat files without shell:true (EINVAL since the CVE-2024-27980
 * hardening) -- so the sync silently failed on every native-Windows release.
 * Running npm-cli.js under the current node binary sidesteps both the shim
 * and the shell. Same resolution ladder as scripts/ensure-native-modules.cjs.
 */
function resolveNpmCommand() {
    const nodeBinDir = dirname(process.execPath);
    const candidates = [
        process.env.npm_execpath,
        join(nodeBinDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(nodeBinDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(dirname(nodeBinDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (existsSync(candidate)) return [process.execPath, candidate];
    }
    return [process.platform === 'win32' ? 'npm.cmd' : 'npm'];
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
    const [npmBin, ...npmBaseArgs] = resolveNpmCommand();
    const result = spawnSync(
        npmBin,
        [...npmBaseArgs, 'version', rootVersion, '--no-git-tag-version', '--allow-same-version'],
        {
            cwd: electronDir,
            encoding: 'utf8',
            timeout: 60_000,
            // .cmd shims need a shell; the npm-cli.js path never takes this branch.
            shell: npmBin.endsWith('.cmd'),
        },
    );
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || (result.error && result.error.message) || '').trim();
        console.error(`ERROR: npm version failed in electron/: ${detail}`);
        return 1;
    }

    console.log(`[electron-version] synced ${electronVersion} -> ${rootVersion}`);
    return 0;
}

process.exit(main());
