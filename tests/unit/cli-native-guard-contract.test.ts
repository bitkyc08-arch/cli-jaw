import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('CLI entrypoint runs native guard before importing subcommands', () => {
    const src = read('bin/cli-jaw.ts');
    const guardCall = src.indexOf('ensureNativeModulesReady(command);');
    const switchStart = src.indexOf('switch (command)');

    assert.ok(guardCall >= 0, 'native guard call must exist');
    assert.ok(switchStart >= 0, 'root command switch must exist');
    assert.ok(guardCall < switchStart, 'native guard must run before dynamic command imports');
    assert.match(src, /process\.execPath/);
    assert.match(src, /scripts', 'ensure-native-modules\.cjs'/);
});

test('native guard is skipped for help and version commands', () => {
    const src = read('bin/cli-jaw.ts');

    assert.match(src, /cmd === '--help'/);
    assert.match(src, /cmd === '-h'/);
    assert.match(src, /cmd === '--version'/);
    assert.match(src, /cmd === '-v'/);
});

test('ensure-native rebuilds from package root with current Node npm', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    assert.match(src, /const root = join\(__dirname, '\.\.'\)/);
    assert.match(src, /dirname\(process\.execPath\)/);
    assert.match(src, /process\.env\.npm_execpath/);
    assert.match(src, /npm-cli\.js/);
    assert.match(src, /execFileSync\(command\.bin, \[\.\.\.command\.baseArgs, \.\.\.args\]/);
    assert.match(src, /PATH: \[nodeBinDir, process\.env\.PATH \|\| ''\]/);
    assert.match(src, /node_modules', 'better-sqlite3'/);
    assert.match(src, /rmSync\(join\(betterSqliteDir, 'build'\), \{ recursive: true, force: true \}\)/);
    assert.match(src, /'run', 'install', '--foreground-scripts'/);
    assert.match(src, /npm_config_target: process\.versions\.node/);
    assert.match(src, /cwd: betterSqliteDir/);
    assert.doesNotMatch(src, /cwd: process\.cwd\(\)/);
    assert.doesNotMatch(src, /npm_config_build_from_source: 'true'/);
    assert.doesNotMatch(src, /shell: true/);
});

test('ensure-native opens an in-memory database to prove ABI compatibility', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    assert.match(src, /new Database\(':memory:'\)/);
    assert.match(src, /db\.close\(\)/);
});

// ─── 010: native failure classification (defect D1) ───

type Classify = (error: unknown, resolved: boolean) => 'missing' | 'abi' | 'other';

async function loadClassifier(): Promise<Classify> {
    const mod = await import(join(projectRoot, 'scripts', 'ensure-native-modules.cjs'));
    const fn = (mod.default ?? mod).classifyNativeError as Classify;
    assert.equal(typeof fn, 'function', 'classifyNativeError must be exported');
    return fn;
}

function errorWith(message: string, code?: string): Error {
    const error = new Error(message);
    if (code) (error as NodeJS.ErrnoException).code = code;
    return error;
}

test('a missing install is never classified as a recoverable ABI mismatch', async () => {
    const classify = await loadClassifier();
    // Regression guard for D1: this message contains the substring 'better-sqlite3',
    // which the previous substring matcher treated as a recoverable ABI mismatch and
    // "repaired" with a pointless rebuild before printing a raw stack trace.
    const notFound = errorWith("Cannot find module 'better-sqlite3'", 'MODULE_NOT_FOUND');

    assert.equal(classify(notFound, false), 'missing');
    assert.equal(classify(notFound, true), 'missing');
});

test('real ABI mismatches stay recoverable so auto-rebuild does not regress', async () => {
    const classify = await loadClassifier();

    assert.equal(
        classify(errorWith('NODE_MODULE_VERSION 127. This version of Node.js requires 137', 'ERR_DLOPEN_FAILED'), true),
        'abi',
    );
    assert.equal(classify(errorWith('was compiled against a different Node.js version'), true), 'abi');
    assert.equal(classify(errorWith('dlopen failed for better_sqlite3.node'), true), 'abi');
});

test('unrelated native failures are not rebuilt blindly', async () => {
    const classify = await loadClassifier();

    assert.equal(classify(errorWith('mach-o file, but is an incompatible architecture'), true), 'other');
    assert.equal(classify(errorWith('libc.so.6: version GLIBC_2.38 not found'), true), 'other');
});

test('ensure-native separates resolution from loading and reports an actionable install hint', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    assert.match(src, /createRequire/);
    assert.match(src, /\.resolve\('better-sqlite3'\)/);
    assert.match(src, /run: npm install/);
    // Diagnosis must carry the facts needed to debug a failed repair.
    assert.match(src, /process\.versions\.modules/);
    // Presence of a node_modules directory is not a valid readiness signal.
    assert.doesNotMatch(src, /existsSync\(join\(root, 'node_modules'\)\)/);
});

// ─── 030: cross-process repair lock (defect D4) ───

test('native repair is serialized by an atomically acquired lock', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    // mkdir is the atomic primitive; a bare existsSync check would race.
    assert.match(src, /mkdirSync\(LOCK_DIR, \{ recursive: false \}\)/);
    assert.match(src, /acquireRepairLock/);
    assert.match(src, /releaseRepairLock/);
});

test('the repair lock re-probes under the lock instead of rebuilding blindly', () => {
    const src = read('scripts/ensure-native-modules.cjs');
    const acquire = src.indexOf('const locked = acquireRepairLock');
    const reprobe = src.indexOf('was repaired by another process');
    const rebuild = src.indexOf('rebuildBetterSqlite3();');

    assert.ok(acquire >= 0 && reprobe >= 0 && rebuild >= 0);
    assert.ok(acquire < reprobe, 'the re-check must happen after acquiring the lock');
    assert.ok(reprobe < rebuild, 'a waiter must not rebuild what another process already fixed');
});

test('a repair lock is reclaimed by owner liveness, not by elapsed time alone', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    // A slow but healthy rebuild must never have its lock stolen, so elapsed
    // time is only a backstop for a PID that cannot be probed at all.
    assert.match(src, /isLockOwnerAlive/);
    assert.match(src, /process\.kill\(pid, 0\)/);
    assert.match(src, /ownerAlive === false/);
    assert.match(src, /ownerAlive === null && age !== null && age > LOCK_STALE_MS/);
});

test('the repair lock lives outside node_modules', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    // The script's own failure mode is a missing/pruned dependency tree, and a
    // concurrent npm install can delete node_modules while the lock is held.
    assert.doesNotMatch(src, /LOCK_DIR = join\(\s*root,\s*'node_modules'/);
    assert.match(src, /tmpdir\(\)/);
    assert.match(src, /createHash\('sha256'\)\.update\(realRoot\)/);
});

test('the repair lock is released even though process.exit skips finally', () => {
    const src = read('scripts/ensure-native-modules.cjs');

    assert.match(src, /process\.on\('exit', releaseRepairLock\)/);
});
