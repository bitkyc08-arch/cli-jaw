#!/usr/bin/env node
/**
 * ensure-native-modules.cjs
 *
 * Verifies that native addons needed for local runtime are loadable.
 * If better-sqlite3 exists but was built against a different Node ABI,
 * rebuild it in-place before build/test steps continue.
 */
const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } = require('fs');
const { delimiter, dirname, join } = require('path');
const { createRequire } = require('module');
const { createHash } = require('crypto');
const { tmpdir } = require('os');

const root = join(__dirname, '..');
// Resolve symlinks so launching through a symlinked bin shares one lock identity.
let realRoot = root;
try { realRoot = realpathSync(root); } catch { /* fall back to the literal path */ }
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

// ─── cross-process repair lock ──────────────────────
//
// Two processes rebuilding in the same directory race over one build/ tree,
// because node-gyp rebuild is clean + configure + build. jaw can hit this
// easily: the dashboard, the CLI and the Electron sidecar may all start at once.
//
// mkdir is atomic on POSIX and Windows, so it is used as the acquire primitive.
// No external dependency is taken: this script must run before install
// completes, so it can only rely on Node built-ins.
// The lock deliberately lives OUTSIDE node_modules: this script's own failure
// mode is a missing/pruned dependency tree, and a concurrent npm install can
// remove that directory while the lock is held. It is keyed by the resolved
// install root so every entry point into the same installation shares one lock.
const LOCK_DIR = join(
    tmpdir(),
    `jaw-native-rebuild-${createHash('sha256').update(realRoot).digest('hex').slice(0, 16)}.lock`,
);
// Liveness is decided by the owner PID, not by elapsed time: the rebuild runs
// synchronously (execFileSync blocks the event loop), so a timer-based heartbeat
// could never fire while the lock is actually held. The age check below is only a
// backstop for a PID that cannot be probed.
const LOCK_STALE_MS = 60 * 60 * 1000;

/** Block this process without spinning the CPU (this script is synchronous). */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockAgeMs() {
    try {
        return Date.now() - statSync(LOCK_DIR).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * Is the process that recorded ownership still alive?
 *
 * @returns {boolean|null} null when liveness cannot be determined
 */
function isLockOwnerAlive() {
    let pid;
    try {
        pid = Number.parseInt(readFileSync(join(LOCK_DIR, 'owner'), 'utf8').trim(), 10);
    } catch {
        return null;
    }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return true;
    try {
        // Signal 0 performs the permission/existence check without delivering.
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error && error.code === 'EPERM') return true;  // alive, owned by another user
        if (error && error.code === 'ESRCH') return false;
        return null;
    }
}

function acquireRepairLock(waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            mkdirSync(LOCK_DIR, { recursive: false });
            try {
            writeFileSync(join(LOCK_DIR, 'owner'), String(process.pid));
            } catch { /* ownership record is advisory only */ }
            return true;
        } catch (error) {
            if (!error || error.code !== 'EEXIST') return false;

            // Reclaim only a lock whose owner is provably gone. A slow but healthy
            // rebuild must never have its lock stolen, so elapsed time alone is
            // not sufficient grounds for reclaiming.
            const ownerAlive = isLockOwnerAlive();
            const age = readLockAgeMs();
            const abandoned = ownerAlive === false
                || (ownerAlive === null && age !== null && age > LOCK_STALE_MS);
            if (abandoned) {
                console.warn('[jaw:native] reclaiming repair lock abandoned by a dead process');
                try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* retry below */ }
                continue;
            }
            if (Date.now() >= deadline) return false;
            sleepSync(250);
        }
    }
}

function releaseRepairLock() {
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

function reportMissing() {
    console.error('[jaw:native] ❌ dependencies are not installed (cannot resolve better-sqlite3).');
    console.error(`[jaw:native]    install root: ${root}`);
    console.error('[jaw:native]    run: npm install');
}

module.exports = {
    classifyNativeError,
    // Exposed so the lock contract can be exercised for real rather than
    // asserted against source text.
    __testing: {
        lockDir: LOCK_DIR,
        acquire: acquireRepairLock,
        release: releaseRepairLock,
    },
};

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

// Serialize repair across processes. Waiting is the normal outcome here, not an
// error: whoever holds the lock is fixing the very thing this process needs.
const locked = acquireRepairLock(5 * 60 * 1000);
if (!locked) {
    console.error('[jaw:native] another process is repairing native modules and did not finish in time.');
    console.error(`[jaw:native] if no such process is running, remove: ${LOCK_DIR}`);
    process.exit(1);
}

// process.exit() skips finally blocks, and a crash skips them too; the stale
// reclaim above is the backstop, but releasing on exit keeps the common case clean.
process.on('exit', releaseRepairLock);

try {
    // Re-check under the lock: the process we waited for may already have fixed it.
    if (!loadBetterSqlite3()) {
        console.log('[jaw:native] better-sqlite3 was repaired by another process.');
        releaseRepairLock();
        process.exit(0);
    }

    console.warn('[jaw:native] better-sqlite3 load failed — rebuilding native module for current Node runtime...');
    rebuildBetterSqlite3();

    const secondError = loadBetterSqlite3();
    if (secondError) {
        console.error('[jaw:native] better-sqlite3 is still not loadable after rebuild.');
        console.error(`[jaw:native] ${runtimeFacts()}`);
        console.error(secondError);
        releaseRepairLock();
        process.exit(1);
    }

    console.log('[jaw:native] better-sqlite3 is ready for this Node runtime.');
} finally {
    releaseRepairLock();
}
