#!/usr/bin/env node
/**
 * postinstall-guard.cjs — Cross-platform guard for postinstall.
 *
 * ⚠️ INTENTIONALLY CommonJS (.cjs) — DO NOT convert to TypeScript.
 * Reason: Runs during `npm postinstall` BEFORE any build step.
 * At this point, tsx/tsc may not be available (fresh install).
 * Must work with bare Node.js on all platforms (macOS/Linux/Windows).
 *
 * 1. Node version check (fail-fast before any build attempt)
 * 2. Repair package bin permissions, then safe mode exits before build/install work
 * 3. dist/bin/postinstall.js exists? → run it
 * 4. Dev clone fallback: local tsc → build → run dist/bin/postinstall.js
 *    - No local tsc → exit 1 with clear instruction
 *    - tsc fails → exit 1
 *
 * Intentionally CommonJS (.cjs) — runs without compilation,
 * cross-platform (Windows cmd.exe compatible).
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

// ─── 1. Node version fail-fast ──────────────────────
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
    console.error(`[jaw:init] ❌ Node.js >= 22 required (current: ${process.version})`);
    console.error(`[jaw:init]    Install: https://nodejs.org or nvm install 22`);
    process.exit(1);
}

// ─── 2. dist/ target + package-bin permission repair ─
const root = path.join(__dirname, '..');
const target = path.join(root, 'dist', 'bin', 'postinstall.js');

function ensurePackageBinExecutable(rootDir) {
    if (process.platform === 'win32') return;
    const binPath = path.join(rootDir, 'dist', 'bin', 'cli-jaw.js');
    if (!fs.existsSync(binPath)) return;
    try {
        fs.chmodSync(binPath, 0o755);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[jaw:init] ⚠️  could not repair cli-jaw executable bit: ${message}`);
    }
}

ensurePackageBinExecutable(root);

// ─── 3. Safe mode: no build/install work ────────────
const safeMode =
    process.env.JAW_SAFE === '1'
    || process.env.JAW_SAFE === 'true'
    || process.env.CLI_JAW_SAFE === '1'
    || process.env.CLI_JAW_SAFE === 'true'
    || process.env.npm_config_jaw_safe === '1'
    || process.env.npm_config_jaw_safe === 'true';

if (safeMode) {
    console.log('[jaw:init] safe mode — skipping postinstall build and installers');
    process.exit(0);
}

async function runCompiledPostinstall() {
    const mod = await import(pathToFileURL(target).href);
    if (typeof mod.runPostinstall !== 'function') {
        throw new Error('dist/bin/postinstall.js does not export runPostinstall()');
    }
    await mod.runPostinstall();
}

// ─── 4. Dev clone: build with local tsc ─────────────
if (!fs.existsSync(target)) {
    // Check both unix and Windows (.cmd) shim paths
    const binDir = path.join(root, 'node_modules', '.bin');
    const localTsc = [
        path.join(binDir, 'tsc'),
        path.join(binDir, 'tsc.cmd'),
        path.join(binDir, 'tsc.ps1'),
    ].find(p => fs.existsSync(p));

    if (!localTsc) {
        console.error('[jaw:init] ❌ dist/ not found and typescript not installed locally');
        console.error('           Run: npm install --ignore-scripts && npm run build && node dist/bin/postinstall.js');
        process.exit(1);
    }

    console.log('[jaw:init] dist/ not found, building...');
    try {
        // execFileSync avoids shell parsing issues with spaces in paths
        execFileSync(localTsc, [], { stdio: 'inherit', cwd: root, timeout: 60000 });
    } catch {
        console.error('[jaw:init] ❌ build failed — run manually:');
        console.error('           npm run build && node dist/bin/postinstall.js');
        process.exit(1);
    }

    if (!fs.existsSync(target)) {
        console.error('[jaw:init] ❌ tsc completed but dist/bin/postinstall.js not found');
        process.exit(1);
    }
    ensurePackageBinExecutable(root);
}

runCompiledPostinstall().catch((error) => {
    console.error('[jaw:init] ⚠️  postinstall error (non-fatal):');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(0);
});
