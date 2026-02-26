#!/usr/bin/env node
/**
 * postinstall-guard.cjs — Cross-platform guard for postinstall.
 *
 * 1. Node version check (fail-fast before any build attempt)
 * 2. dist/bin/postinstall.js exists? → exit 0
 * 3. Dev clone fallback: local tsc → build → exit 0
 *    - No local tsc → exit 1 with clear instruction
 *    - tsc fails → exit 1
 *
 * Intentionally CommonJS (.cjs) — runs without compilation,
 * cross-platform (Windows cmd.exe compatible).
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

// ─── 1. Node version fail-fast ──────────────────────
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
    console.error(`[jaw:init] ❌ Node.js >= 22 required (current: ${process.version})`);
    console.error(`[jaw:init]    Install: https://nodejs.org or nvm install 22`);
    process.exit(1);
}

// ─── 2. dist/ exists? ───────────────────────────────
const root = path.join(__dirname, '..');
const target = path.join(root, 'dist', 'bin', 'postinstall.js');

if (fs.existsSync(target)) {
    // Registry install or already built — proceed directly
    process.exit(0);
}

// ─── 3. Dev clone: build with local tsc ─────────────
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
