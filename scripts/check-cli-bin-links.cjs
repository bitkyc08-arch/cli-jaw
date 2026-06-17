#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_BIN = {
  'cli-jaw': 'dist/bin/cli-jaw.js',
  jaw: 'dist/bin/cli-jaw.js',
};

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { allowMissingDist: false };
  for (const arg of argv) {
    if (arg === '--allow-missing-dist') {
      args.allowMissingDist = true;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return args;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`failed to read JSON ${filePath}: ${detail}`);
  }
}

function assertPackageBin(repoRoot) {
  const actual = readJson(path.join(repoRoot, 'package.json')).bin || {};
  for (const [name, target] of Object.entries(EXPECTED_BIN)) {
    if (actual[name] !== target) {
      fail(`package.json bin.${name} must be ${target}, got ${actual[name] || 'missing'}`);
    }
  }
}

function assertEntry(repoRoot, allowMissingDist) {
  const entry = path.join(repoRoot, EXPECTED_BIN['cli-jaw']);
  if (!fs.existsSync(entry)) {
    if (allowMissingDist) return;
    fail(`CLI entry missing: ${entry}`);
  }
  const firstLine = fs.readFileSync(entry, 'utf8').split(/\r?\n/, 1)[0] || '';
  if (!firstLine.startsWith('#!/usr/bin/env node')) {
    fail(`CLI entry must start with node shebang: ${entry}`);
  }
  if (process.platform !== 'win32' && (fs.statSync(entry).mode & 0o100) === 0) {
    fail(`CLI entry is not executable: ${entry}`);
  }
}

function npmPrefix() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['prefix', '-g'], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function globalBinDir(prefix) {
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function globalPackageDir(prefix) {
  return process.platform === 'win32'
    ? path.join(prefix, 'node_modules', 'cli-jaw')
    : path.join(prefix, 'lib', 'node_modules', 'cli-jaw');
}

function sameRealPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function assertExistingGlobalShims(repoRoot) {
  const prefix = npmPrefix();
  if (!prefix) return;
  const binDir = globalBinDir(prefix);
  const packageDir = globalPackageDir(prefix);
  const packageDirExists = fs.existsSync(packageDir);

  for (const name of Object.keys(EXPECTED_BIN)) {
    const candidates = process.platform === 'win32'
      ? [path.join(binDir, `${name}.cmd`), path.join(binDir, name)]
      : [path.join(binDir, name)];
    const shim = candidates.find(fs.existsSync);
    if (!shim) continue;

    if (process.platform !== 'win32' && (fs.statSync(shim).mode & 0o100) === 0) {
      fail(`global ${name} shim is not executable: ${shim}`);
    }

    if (packageDirExists && sameRealPath(shim, path.join(packageDir, EXPECTED_BIN[name]))) continue;
    if (sameRealPath(shim, path.join(repoRoot, EXPECTED_BIN[name]))) continue;

    let real = shim;
    try {
      real = fs.realpathSync(shim);
    } catch {
      // keep shim path in message
    }
    fail(`global ${name} shim points outside this package entry: ${shim} -> ${real}`);
  }
}

const repoRoot = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
assertPackageBin(repoRoot);
assertEntry(repoRoot, args.allowMissingDist);
assertExistingGlobalShims(repoRoot);
console.log('[cli-bin-links] OK');
