#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

function usage(message) {
  if (message) console.error(`ERROR: ${message}`);
  console.error('Usage: node scripts/prepare-sidecar-package-json.cjs --package-json <path> --remove-dependency <name> [--remove-dependency <name>...]');
  process.exit(1);
}

let packageJsonPath = '';
const removeDependencies = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--package-json') {
    packageJsonPath = args[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg === '--remove-dependency') {
    const name = args[index + 1] || '';
    if (!name) usage('--remove-dependency requires a package name');
    removeDependencies.push(name);
    index += 1;
    continue;
  }
  usage(`unknown argument: ${arg}`);
}

if (!packageJsonPath) usage('--package-json is required');
if (removeDependencies.length === 0) usage('at least one --remove-dependency is required');

const resolvedPath = resolve(packageJsonPath);
let pkg;
try {
  pkg = JSON.parse(readFileSync(resolvedPath, 'utf8'));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  usage(`failed to read ${resolvedPath}: ${detail}`);
}

for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  if (!pkg[field]) continue;
  for (const name of removeDependencies) {
    delete pkg[field][name];
  }
  if (Object.keys(pkg[field]).length === 0) {
    delete pkg[field];
  }
}

writeFileSync(resolvedPath, `${JSON.stringify(pkg, null, 2)}\n`);
