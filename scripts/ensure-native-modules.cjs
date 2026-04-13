#!/usr/bin/env node
/**
 * ensure-native-modules.cjs
 *
 * Verifies that native addons needed for local runtime are loadable.
 * If better-sqlite3 exists but was built against a different Node ABI,
 * rebuild it in-place before build/test steps continue.
 */
const { execFileSync } = require('child_process');

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
execFileSync(npmBin, ['rebuild', 'better-sqlite3'], {
    stdio: 'inherit',
    cwd: process.cwd(),
});

const secondError = loadBetterSqlite3();
if (secondError) {
    console.error('[jaw:native] better-sqlite3 is still not loadable after rebuild.');
    console.error(secondError);
    process.exit(1);
}

console.log('[jaw:native] better-sqlite3 is ready for this Node runtime.');
