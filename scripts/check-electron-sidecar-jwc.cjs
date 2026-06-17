#!/usr/bin/env node
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function checkFile(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} missing: ${filePath}`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} is not readable JSON: ${detail}`);
  }
}

function findNodeBin(serverRoot) {
  const candidates = [join(serverRoot, 'node'), join(serverRoot, 'node.exe')];
  return candidates.find(existsSync) || candidates[0];
}

function shimPath(serverRoot, name) {
  const candidates = [join(serverRoot, 'bin', name), join(serverRoot, 'bin', `${name}.cmd`)];
  return candidates.find(existsSync) || candidates[0];
}

function dependencyPackagePath(serverRoot, name) {
  const candidates = [
    join(serverRoot, 'node_modules', name, 'package.json'),
    join(serverRoot, 'node_modules', 'jawcode', 'node_modules', name, 'package.json'),
  ];
  return candidates.find(existsSync) || candidates[0];
}

function checkPackageLock(serverRoot) {
  const locks = [
    join(serverRoot, 'node_modules', '.package-lock.json'),
    join(serverRoot, 'package-lock.json'),
  ];
  for (const lockPath of locks) {
    if (!existsSync(lockPath)) continue;
    const lock = readJson(lockPath, lockPath);
    const jawcode = lock.packages?.['node_modules/jawcode'];
    if (jawcode?.link === true) {
      fail(`jawcode must be installed as a real package, not a link: ${lockPath}`);
    }
  }
}

function runSdkImport(nodeBin, serverRoot) {
  const code = `
    const sdk = await import('jawcode/sdk');
    if (typeof sdk.createAgentSession !== 'function') {
      throw new Error('missing createAgentSession');
    }
  `;
  const result = spawnSync(nodeBin, ['--input-type=module', '-e', code], {
    cwd: serverRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`jawcode/sdk import failed with bundled Node\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`);
  }
}

const unknown = process.argv.slice(2).filter((arg, index, args) => {
  if (arg === '--server-root') return false;
  if (args[index - 1] === '--server-root') return false;
  return arg.startsWith('-');
});
if (unknown.length > 0) {
  fail(`unknown argument: ${unknown.join(', ')}`);
}

const serverRoot = resolve(parseArg('--server-root') || 'electron/sidecar/server');
const nodeBin = findNodeBin(serverRoot);

checkFile(nodeBin, 'bundled Node');
checkFile(shimPath(serverRoot, 'jaw'), 'jaw shim');
checkFile(shimPath(serverRoot, 'jwc'), 'jwc shim');
checkFile(join(serverRoot, 'node_modules', 'jawcode', 'package.json'), 'jawcode package');
checkFile(join(serverRoot, 'node_modules', 'jawcode', 'dist-node', 'sdk.js'), 'jawcode SDK');
checkFile(join(serverRoot, 'node_modules', 'jawcode', 'bin', 'jwc.js'), 'jwc binary entry');

for (const dep of ['json5', 'strip-ansi', 'markit-ai']) {
  checkFile(dependencyPackagePath(serverRoot, dep), `${dep} dependency`);
}

checkPackageLock(serverRoot);
runSdkImport(nodeBin, serverRoot);

console.log(`[electron-sidecar-jwc] OK ${serverRoot}`);
