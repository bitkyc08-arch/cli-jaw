#!/usr/bin/env node
const { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

function retiredPackage(name) {
  return /^(?:jawcode|jwc|bun)$/.test(name)
    || /^@(?:jawcode(?:-[^/]+)?|gajae(?:-[^/]+)?|oven)(?:\/|$)/.test(name);
}

// Shared by staged/platform sidecars and the npm packed-file manifest check.
function retiredPayloadReason(file) {
  const normalized = file.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some(retiredPackage)) return 'retired package or scope';
  if (/(?:^|\/)src\/lib\/tui(?:\/|$)/.test(normalized)) return 'retired TUI assets';
  if (parts.some(part => /^pi_natives(?:\.|$)/.test(part))) return 'retired native addon';
  if (parts.some(part => /^(?:jawcode-(?:tui|interactive)-bundle|bun-shim)(?:\.|$)/.test(part))) return 'retired TUI bundle';
  if (/(?:^|\/)(?:\.bin|bin)\/jwc(?:\.(?:cmd|ps1|exe|js))?$/.test(normalized)) return 'jwc shim';
  if (/(?:^|\/)(?:jwc-runtime|jwc-event-mapper|jawcode-render|jawcode-bridge)\.(?:[cm]?[jt]s)(?:\.map)?$/.test(normalized)
      || /(?:^|\/)bin\/commands\/jwc\./.test(normalized)
      || /(?:^|\/)scripts\/jwc-(?:110-e2e|no-global-smoke)\.mjs$/.test(normalized)) return 'retired executable';
  return null;
}

function assertRetiredManifestAbsent(manifest, label) {
  if (retiredPackage(manifest.name || '')) throw new Error(`${label}: retired package ${manifest.name}`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] || {})) {
      const alias = typeof spec === 'string' && spec.startsWith('npm:') ? spec.slice(4).replace(/@[^/]*$/, '') : '';
      if (retiredPackage(name) || retiredPackage(alias)) throw new Error(`${label}: retired dependency ${name}`);
      if (spec && typeof spec === 'object') assertRetiredManifestAbsent(spec, `${label}:${name}`);
    }
  }
  const bundled = manifest.bundleDependencies || manifest.bundledDependencies;
  for (const name of Array.isArray(bundled) ? bundled : []) {
    if (retiredPackage(name)) throw new Error(`${label}: retired bundled dependency ${name}`);
  }
  if (manifest.bin && typeof manifest.bin === 'object' && Object.hasOwn(manifest.bin, 'jwc')) {
    throw new Error(`${label}: jwc shim declaration`);
  }
  for (const [file, entry] of Object.entries(manifest.packages || {})) {
    const reason = retiredPayloadReason(file);
    if (reason) throw new Error(`${label}: ${reason}: ${file}`);
    assertRetiredManifestAbsent(entry, `${label}:${file}`);
  }
}

function checkSidecar(serverRoot) {
  for (const [label, candidates] of [
    ['bundled Node', ['node', 'node.exe']],
    ['jaw shim', ['bin/jaw', 'bin/jaw.cmd']],
  ]) {
    if (!candidates.some(file => existsSync(join(serverRoot, file)))) {
      throw new Error(`${label} missing: ${serverRoot}`);
    }
  }
  const root = realpathSync(serverRoot);
  const visited = new Set();
  const walk = (dir, prefix = '') => {
    const identity = realpathSync(dir);
    if (visited.has(identity)) return;
    visited.add(identity);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      const reason = retiredPayloadReason(file);
      if (reason) throw new Error(`${reason} must not be bundled: ${file}`);
      const absolute = join(dir, entry.name);
      // Resolve contained links without letting an alias hide a retired package.
      // Never read payload outside the staged tree or recurse through link cycles.
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (retiredPayloadReason(target)) throw new Error(`retired symlink target must not be bundled: ${file}`);
        if (!existsSync(absolute)) continue;
        const rel = relative(root, realpathSync(absolute));
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`cannot inspect payload outside staged tree: ${file}`);
        }
      }
      if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(absolute).isDirectory())) {
        walk(absolute, file);
      } else if (entry.name === 'package.json' || entry.name === 'package-lock.json' || entry.name === 'npm-shrinkwrap.json') {
        assertRetiredManifestAbsent(JSON.parse(readFileSync(absolute, 'utf8')), file);
      }
    }
  };
  walk(serverRoot);
}

module.exports = { retiredPayloadReason, assertRetiredManifestAbsent };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--server-root' || args[1].startsWith('-'))) {
      throw new Error('usage: check-electron-sidecar-no-jwc.cjs [--server-root <path>]');
    }
    const serverRoot = resolve(args[1] || 'electron/sidecar/server');
    checkSidecar(serverRoot);
    console.log(`[electron-sidecar-no-jwc] OK ${serverRoot}`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
