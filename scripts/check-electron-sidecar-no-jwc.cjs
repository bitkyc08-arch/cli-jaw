#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

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

function checkAbsent(filePath, label) {
  if (existsSync(filePath)) {
    fail(`${label} must not be bundled: ${filePath}`);
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

const unknown = process.argv.slice(2).filter((arg, index, args) => {
  if (arg === '--server-root') return false;
  if (args[index - 1] === '--server-root') return false;
  return arg.startsWith('-');
});
if (unknown.length > 0) {
  fail(`unknown argument: ${unknown.join(', ')}`);
}

const serverRoot = resolve(parseArg('--server-root') || 'electron/sidecar/server');

checkFile(findNodeBin(serverRoot), 'bundled Node');
checkFile(shimPath(serverRoot, 'jaw'), 'jaw shim');
checkAbsent(shimPath(serverRoot, 'jwc'), 'jwc shim');
checkAbsent(join(serverRoot, 'node_modules', 'jawcode'), 'jawcode package');
checkAbsent(join(serverRoot, 'node_modules', '@jawcode-dev'), '@jawcode-dev scope');
checkAbsent(join(serverRoot, 'node_modules', '@oven'), '@oven scope');
checkAbsent(join(serverRoot, 'node_modules', 'bun'), 'bun package');

console.log(`[electron-sidecar-no-jwc] OK ${serverRoot}`);
