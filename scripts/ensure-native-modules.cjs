#!/usr/bin/env node
/**
 * ensure-native-modules.cjs
 *
 * Verifies that native addons needed for local runtime are loadable.
 * If better-sqlite3 exists but was built against a different Node ABI,
 * rebuild it in-place before build/test steps continue.
 */
const { execFileSync } = require('child_process');
const { existsSync, rmSync } = require('fs');
const { delimiter, dirname, join } = require('path');
const { createRequire } = require('module');

const root = join(__dirname, '..');
const nodeBinDir = dirname(process.execPath);

function npmCliCandidates() {
    return [
        process.env.npm_execpath,
        join(nodeBinDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(nodeBinDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(dirname(nodeBinDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean);
}

function resolveNpmCommand() {
    for (const candidate of npmCliCandidates()) {
        if (existsSync(candidate)) {
            return { bin: process.execPath, baseArgs: [candidate] };
        }
    }
    return { bin: process.platform === 'win32' ? 'npm.cmd' : 'npm', baseArgs: [] };
}

function runNpm(args, options) {
    const command = resolveNpmCommand();
    execFileSync(command.bin, [...command.baseArgs, ...args], options);
}

function nativeBuildEnv() {
    const env = {
        ...process.env,
        PATH: [nodeBinDir, process.env.PATH || ''].filter(Boolean).join(delimiter),
        npm_config_runtime: 'node',
        npm_config_target: process.versions.node,
        npm_config_disturl: 'https://nodejs.org/dist',
    };
    delete env.npm_config_build_from_source;
    return env;
}

function rebuildBetterSqlite3() {
    const betterSqliteDir = join(root, 'node_modules', 'better-sqlite3');
    if (existsSync(join(betterSqliteDir, 'package.json'))) {
        rmSync(join(betterSqliteDir, 'build'), { recursive: true, force: true });
        runNpm(['run', 'install', '--foreground-scripts'], {
            stdio: 'inherit',
            cwd: betterSqliteDir,
            env: nativeBuildEnv(),
        });
        return;
    }
    if (existsSync(join(root, 'pnpm-lock.yaml'))) {
        execFileSync('corepack', ['pnpm', 'rebuild', 'better-sqlite3'], {
            stdio: 'inherit',
            cwd: root,
            env: nativeBuildEnv(),
        });
        return;
    }
    runNpm(['rebuild', 'better-sqlite3', '--foreground-scripts'], {
        stdio: 'inherit',
        cwd: root,
        env: nativeBuildEnv(),
    });
}

function loadBetterSqlite3() {
    try {
        const Database = require('better-sqlite3');
        const db = new Database(':memory:');
        db.close();
        return null;
    } catch (error) {
        return error;
    }
}

/**
 * Can the dependency be RESOLVED at all?
 *
 * This is deliberately separate from loading it: resolution failure means the
 * install is missing/pruned, while a resolvable-but-unloadable module means an
 * ABI/native problem. Conflating the two makes a missing install look like an
 * ABI mismatch and triggers a pointless rebuild (defect D1).
 *
 * Resolution is used rather than an existsSync('node_modules') check because
 * other layouts (e.g. Plug'n'Play) resolve without that directory.
 */
function canResolveBetterSqlite3() {
    try {
        createRequire(join(root, 'package.json')).resolve('better-sqlite3');
        return true;
    } catch {
        return false;
    }
}

/**
 * Classify a native load failure.
 *
 * @param {unknown} error    the error thrown while loading
 * @param {boolean} resolved whether the package could be resolved at all
 * @returns {'missing'|'abi'|'other'}
 *
 * `missing` is the only class that was narrowed; `abi` stays deliberately broad
 * so the pre-existing auto-recovery for real ABI mismatches does not regress.
 */
function classifyNativeError(error, resolved) {
    if (!resolved) return 'missing';

    const err = /** @type {{ code?: string } | null} */ (error);
    const text = String(error && (/** @type {Error} */ (error).stack || /** @type {Error} */ (error).message || error));

    if (err && err.code === 'MODULE_NOT_FOUND') return 'missing';
    if (
        (err && err.code === 'ERR_DLOPEN_FAILED')
        || text.includes('NODE_MODULE_VERSION')
        || text.includes('ERR_DLOPEN_FAILED')
        || text.includes('better_sqlite3.node')
        || text.includes('was compiled against a different Node.js version')
    ) {
        return 'abi';
    }
    return 'other';
}

function runtimeFacts() {
    return `Node ${process.version} (ABI ${process.versions.modules}), ${process.platform}/${process.arch}`;
}

function reportMissing() {
    console.error('[jaw:native] ❌ dependencies are not installed (cannot resolve better-sqlite3).');
    console.error(`[jaw:native]    install root: ${root}`);
    console.error('[jaw:native]    run: npm install');
}

module.exports = { classifyNativeError };

// Importable for tests; only the direct-run path performs any repair.
if (require.main !== module) return;

const resolvedBefore = canResolveBetterSqlite3();
if (!resolvedBefore) {
    reportMissing();
    process.exit(1);
}

const firstError = loadBetterSqlite3();
if (!firstError) process.exit(0);

const diagnosis = classifyNativeError(firstError, resolvedBefore);

if (diagnosis === 'missing') {
    reportMissing();
    process.exit(1);
}

if (diagnosis === 'other') {
    console.error('[jaw:native] better-sqlite3 load failed with a non-recoverable error.');
    console.error(`[jaw:native] ${runtimeFacts()}`);
    console.error(firstError);
    process.exit(1);
}

console.warn('[jaw:native] better-sqlite3 load failed — rebuilding native module for current Node runtime...');
rebuildBetterSqlite3();

const secondError = loadBetterSqlite3();
if (secondError) {
    console.error('[jaw:native] better-sqlite3 is still not loadable after rebuild.');
    console.error(`[jaw:native] ${runtimeFacts()}`);
    console.error(secondError);
    process.exit(1);
}

console.log('[jaw:native] better-sqlite3 is ready for this Node runtime.');
