#!/usr/bin/env node
/**
 * ensure-native-modules.cjs
 *
 * Verifies that native addons needed for local runtime are loadable.
 * If better-sqlite3 exists but was built against a different Node ABI,
 * rebuild it in-place before build/test steps continue.
 */
const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { dirname, join } = require('path');

const root = join(__dirname, '..');
const nodeBinDir = dirname(process.execPath);
const adjacentNpm = process.platform === 'win32' ? join(nodeBinDir, 'npm.cmd') : join(nodeBinDir, 'npm');
const npmBin = existsSync(adjacentNpm) ? adjacentNpm : (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function rebuildBetterSqlite3() {
    if (existsSync(join(root, 'pnpm-lock.yaml'))) {
        execFileSync('corepack', ['pnpm', 'rebuild', 'better-sqlite3'], {
            stdio: 'inherit',
            cwd: root,
        });
        return;
    }
    execFileSync(npmBin, ['rebuild', 'better-sqlite3'], {
        stdio: 'inherit',
        cwd: root,
    });
}

function loadBetterSqlite3() {
    try {
        require('better-sqlite3');
        return null;
    } catch (error) {
        return error;
    }
}

function isRecoverableNativeMismatch(error) {
    const text = String(error && (error.stack || error.message || error));
    return (
        text.includes('better_sqlite3.node') ||
        text.includes('better-sqlite3') ||
        text.includes('NODE_MODULE_VERSION') ||
        text.includes('ERR_DLOPEN_FAILED')
    );
}

const firstError = loadBetterSqlite3();
if (!firstError) process.exit(0);

if (!isRecoverableNativeMismatch(firstError)) {
    console.error('[jaw:native] better-sqlite3 load failed with a non-recoverable error.');
    console.error(firstError);
    process.exit(1);
}

console.warn('[jaw:native] better-sqlite3 load failed — rebuilding native module for current Node runtime...');
rebuildBetterSqlite3();

const secondError = loadBetterSqlite3();
if (secondError) {
    console.error('[jaw:native] better-sqlite3 is still not loadable after rebuild.');
    console.error(secondError);
    process.exit(1);
}

console.log('[jaw:native] better-sqlite3 is ready for this Node runtime.');
