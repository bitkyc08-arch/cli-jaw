#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import retirement from './check-electron-sidecar-no-jwc.cjs';

const { retiredPayloadReason, assertRetiredManifestAbsent } = retirement;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function checkPackedFiles(files, manifest) {
  assert.ok(Array.isArray(files) && files.length > 0, 'npm pack file manifest is empty');
  const paths = files.map(entry => entry.path);
  assert.ok(paths.includes('package.json'), 'packed package.json missing');
  assert.ok(paths.includes('dist/bin/cli-jaw.js'), 'packed Jaw entrypoint missing');
  for (const file of paths) {
    assert.equal(typeof file, 'string', 'invalid packed file path');
    assert.equal(retiredPayloadReason(file), null, `retired payload must not be packed: ${file}`);
  }
  assertRetiredManifestAbsent(manifest, 'packed package.json');
}

export function checkDefaultInstall(manifest, lock, label = 'root') {
  assertRetiredManifestAbsent(manifest, `${label}/package.json`);
  assertRetiredManifestAbsent(lock, `${label}/package-lock.json`);
  // ai-e remains an on-demand provider, never a default installation.
  for (const pkg of [manifest, ...Object.values(lock.packages || {})]) {
    assert.notEqual(pkg.name, '@bitkyc08/ai-e', 'ai-e must not be installed by default');
    for (const field of ['dependencies', 'optionalDependencies']) {
      assert.equal(pkg[field]?.['@bitkyc08/ai-e'], undefined, 'ai-e must remain an on-demand provider');
    }
  }
  for (const file of Object.keys(lock.packages || {})) {
    assert.ok(!file.replaceAll('\\', '/').endsWith('node_modules/@bitkyc08/ai-e'), 'ai-e must not be in the default install tree');
  }
}

// Exercise the real entrypoint in an owned home. Any attempted child process,
// retired import, or chat fallback is recorded and fails even if caught by CLI.
export function checkRetiredCommand(entrypoint, execArgv = []) {
  assert.ok(existsSync(entrypoint), `CLI build output missing: ${entrypoint}`);
  const owned = mkdtempSync(join(tmpdir(), 'jaw-retired-command-'));
  try {
    const home = join(owned, 'home');
    const jawHome = join(home, '.cli-jaw');
    const prefix = join(jawHome, 'jwc-runtime');
    const sentinel = join(home, '.jwc', 'agent', 'config.yml');
    mkdirSync(dirname(sentinel), { recursive: true });
    mkdirSync(prefix, { recursive: true });
    writeFileSync(sentinel, 'retained user configuration\n');
    writeFileSync(join(prefix, 'installed.txt'), 'retained external installation\n');
    const attempts = join(owned, 'attempts');
    const preload = join(owned, 'deny-effects.mjs');
    writeFileSync(join(owned, 'deny-loader.mjs'), `
import { appendFileSync } from 'node:fs';
export async function resolve(specifier, context, nextResolve) {
  if (/^(?:jawcode|jwc)(?:\\/|$)|^@(?:jawcode|gajae)|(?:^|\\/)commands\\/(?:jwc|chat)\\.[cm]?[jt]s$/.test(specifier)
      || specifier === ${JSON.stringify(join(owned, 'missing-sdk.js'))}
      || specifier === ${JSON.stringify(pathToFileURL(join(owned, 'missing-sdk.js')).href)}) {
    appendFileSync(${JSON.stringify(attempts)}, 'import: ' + specifier + '\\n');
    throw new Error('retired smoke: forbidden import');
  }
  return nextResolve(specifier, context);
}
`);
    writeFileSync(preload, `
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { register, syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => {
    appendFileSync(${JSON.stringify(attempts)}, 'child: ' + name + '\\n');
    throw new Error('retired smoke: forbidden child process');
  };
}
syncBuiltinESMExports();
register('./deny-loader.mjs', import.meta.url);
`);
    const snapshot = dir => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => [entry.name, entry.isDirectory() ? snapshot(join(dir, entry.name)) : readFileSync(join(dir, entry.name), 'utf8')]);
    const before = snapshot(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLI_JAW_HOME: jawHome,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
      NODE_OPTIONS: '', JWC_SDK_PATH: join(owned, 'missing-sdk.js'),
      CLI_JAW_JWC_AGENT_DIR: dirname(sentinel), JAW_SAFE: '1' };
    for (const args of [[], ['install'], ['clean', '--prefix', prefix], ['doctor', '--json'], ['--help']]) {
      const result = spawnSync(process.execPath, [...execArgv, '--import', pathToFileURL(preload).href,
        entrypoint, '--home', jawHome, 'jwc', ...args], {
        cwd: owned, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
      });
      assert.equal(result.error, undefined, `jaw jwc ${args.join(' ')}: ${result.error}`);
      assert.equal(result.status, 1, `jaw jwc must fail: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /retired_runtime:jwc/, `missing retirement diagnostic: ${result.stderr}`);
      assert.equal(result.stdout, '', 'retired command must not enter chat or installer output');
      assert.equal(existsSync(attempts), false, existsSync(attempts) ? readFileSync(attempts, 'utf8') : '');
      assert.deepEqual(snapshot(home), before, 'retired command changed user data or installed runtime');
    }
    const help = spawnSync(process.execPath, [...execArgv, '--import', pathToFileURL(preload).href, entrypoint, '--help'], {
      cwd: owned, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
    });
    assert.equal(help.error, undefined);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /provider install/);
    assert.doesNotMatch(help.stdout, /jwc install|JWC runtime/);
    assert.equal(existsSync(attempts), false);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--source-only'),
    'usage: retired-runtime-package-smoke.mjs [--source-only]');
  const read = file => JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
  const manifest = read('package.json');
  checkDefaultInstall(manifest, read('package-lock.json'));
  checkDefaultInstall(read('electron/package.json'), read('electron/package-lock.json'), 'electron');
  if (args[0] === '--source-only') {
    console.log('[retired-runtime-package:source-only] PASS root/electron manifests and locks; ai-e remains on demand');
    console.log('[retired-runtime-package:source-only] packed NOT RUN; CLI NOT RUN; staged NOT RUN');
    return;
  }
  // Ignore lifecycle scripts: the caller must supply an already built candidate.
  assert.ok(existsSync(join(repoRoot, 'dist/bin/cli-jaw.js')), 'CLI build output missing: full smoke requires a built candidate');
  const npmCli = process.env.npm_execpath;
  const packed = npmCli && existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    });
  assert.equal(packed.error, undefined);
  assert.equal(packed.status, 0, packed.stderr);
  const entries = JSON.parse(packed.stdout);
  assert.equal(entries.length, 1, 'expected one npm package');
  checkPackedFiles(entries[0].files, manifest);
  checkRetiredCommand(join(repoRoot, 'dist/bin/cli-jaw.js'));
  console.log('[retired-runtime-package] PASS manifest, lock, packed files and retired CLI; ai-e remains on demand');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
