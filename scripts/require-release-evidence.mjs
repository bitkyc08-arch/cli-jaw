#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const installerSensitivePaths = [
  '.github/workflows/postinstall-platform.yml',
  'README.md',
  'README.ko.md',
  'README.ja.md',
  'README.zh-CN.md',
  'bin/postinstall.ts',
  'src/core/claude-install.ts',
  'src/core/cli-detect.ts',
  'src/core/runtime-path.ts',
  'scripts/install-risk-gate.mjs',
  'scripts/install.sh',
  'scripts/install-wsl.sh',
  'scripts/fresh-install-smoke.ts',
  'scripts/verify-fresh-install.sh',
  'scripts/collect-fresh-install-evidence.sh',
  'scripts/audit-fresh-install-evidence.mjs',
  'scripts/verify-release-evidence.mjs',
  'scripts/require-release-evidence.mjs',
  'scripts/promote-to-main.sh',
  'scripts/release-preview.sh',
  'tests/unit/cli-detect.test.ts',
  'tests/unit/install-sh-exec.test.ts',
  'tests/unit/fresh-evidence-audit.test.ts',
  'tests/unit/safe-install.test.ts',
  'tests/unit/service.test.ts',
  'tests/unit/postinstall-strict-tools.test.ts',
  'tests/unit/wsl-installer-doctor.test.ts',
  'tests/unit/wsl-installer-exec.test.ts',
  'package.json',
  'package-lock.json',
];

function usage() {
  console.log(`Usage: require-release-evidence.mjs [options]

Options:
  --base-ref REF    Compare installer-sensitive files against REF instead of the latest v* tag.
  --changed-files-stdin
                    Read changed file paths from stdin and check whether any are installer-sensitive.
                    Cannot be combined with --base-ref.
  -h, --help        Show this help.

If installer-sensitive files changed, this script requires:
  CLI_JAW_MACOS_EVIDENCE_DIR=/path/to/macos-evidence
  CLI_JAW_WSL_EVIDENCE_DIR=/path/to/wsl-evidence

Then it runs scripts/verify-release-evidence.mjs before publish/release can continue.
`);
}

let baseRef = '';
let changedFilesStdin = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  }
  if (arg === '--changed-files-stdin') {
    changedFilesStdin = true;
    continue;
  }
  if (arg === '--base-ref') {
    baseRef = args[++i] || '';
    if (!baseRef) throw new Error('missing value for --base-ref');
    continue;
  }
  throw new Error(`unknown option: ${arg}`);
}

if (baseRef && changedFilesStdin) {
  throw new Error('--changed-files-stdin cannot be combined with --base-ref');
}

function readChangedFilesFromStdin() {
  const input = fs.readFileSync(0, 'utf8');
  return input
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0);
}

function git(args, options = {}) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: false,
  });
}

function requireGit(args, label) {
  const result = git(args);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function isGitRepo() {
  return git(['rev-parse', '--is-inside-work-tree']).status === 0;
}

function currentPackageVersionTag() {
  const packageJson = workingTreeFile('package.json');
  if (!packageJson) return '';
  try {
    const version = JSON.parse(packageJson).version;
    return typeof version === 'string' && version ? `v${version}` : '';
  } catch {
    return '';
  }
}

function latestVersionTag() {
  const result = git(['tag', '--sort=-v:refname']);
  if (result.status !== 0) return '';
  const currentTag = currentPackageVersionTag();
  const tags = result.stdout
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag));
  return tags.find((tag) => tag !== currentTag) || '';
}

function gitFile(ref, relativePath) {
  const result = git(['show', `${ref}:${relativePath}`]);
  if (result.status !== 0) return null;
  return result.stdout;
}

function workingTreeFile(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizePackageJson(content) {
  const parsed = JSON.parse(content);
  delete parsed.version;
  return stableStringify(parsed);
}

function normalizePackageLock(content) {
  const parsed = JSON.parse(content);
  delete parsed.version;
  if (parsed.packages?.['']) {
    delete parsed.packages[''].version;
  }
  return stableStringify(parsed);
}

function normalizeForEvidence(relativePath, content) {
  if (content === null) return null;
  if (relativePath === 'package.json') return normalizePackageJson(content);
  if (relativePath === 'package-lock.json') return normalizePackageLock(content);
  return content.replace(/\r\n/g, '\n');
}

function changedInstallerFiles(ref) {
  const changed = [];
  for (const relativePath of installerSensitivePaths) {
    const before = normalizeForEvidence(relativePath, gitFile(ref, relativePath));
    const after = normalizeForEvidence(relativePath, workingTreeFile(relativePath));
    if (before !== after) {
      changed.push(relativePath);
    }
  }
  return changed;
}

function shortHash(files) {
  return crypto.createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
}

if (changedFilesStdin) {
  const inputFiles = readChangedFilesFromStdin();
  const matched = inputFiles.filter((file) => installerSensitivePaths.includes(file));
  if (matched.length === 0) {
    console.log('[release-evidence-required] SKIP no installer-sensitive paths in stdin');
    process.exit(0);
  }
  console.error(`[release-evidence-required] CHANGED installer-sensitive files (${matched.length}, ${shortHash(matched)})`);
  for (const file of matched) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

if (!isGitRepo()) {
  console.error('[release-evidence-required] FAIL');
  console.error('- Cannot determine installer-sensitive changes outside a git checkout.');
  console.error('- Publish from the release checkout, or run scripts/verify-release-evidence.mjs manually before packaging.');
  process.exit(1);
}

const ref = baseRef || latestVersionTag();
if (!ref) {
  console.error('[release-evidence-required] no previous v* tag found; treating release as installer-sensitive');
}
if (ref) {
  requireGit(['rev-parse', '--verify', `${ref}^{commit}`], `base ref ${ref}`);
}

const changed = ref ? changedInstallerFiles(ref) : installerSensitivePaths;
if (!changed.length) {
  console.log(`[release-evidence-required] SKIP no installer-sensitive changes since ${ref}`);
  process.exit(0);
}

const macosEvidence = process.env.CLI_JAW_MACOS_EVIDENCE_DIR || process.env.MACOS_EVIDENCE_DIR || '';
const wslEvidence = process.env.CLI_JAW_WSL_EVIDENCE_DIR || process.env.WSL_EVIDENCE_DIR || '';

console.error(`[release-evidence-required] installer-sensitive changes detected since ${ref || '(initial release)'} (${changed.length}, ${shortHash(changed)})`);
for (const file of changed.slice(0, 30)) {
  console.error(`- ${file}`);
}
if (changed.length > 30) {
  console.error(`- ... ${changed.length - 30} more`);
}

if (!macosEvidence || !wslEvidence) {
  console.error('[release-evidence-required] FAIL');
  console.error('Strict fresh-machine evidence is required before git push or npm publish.');
  console.error('Set both variables and rerun:');
  console.error('  CLI_JAW_MACOS_EVIDENCE_DIR=/path/to/macos-evidence');
  console.error('  CLI_JAW_WSL_EVIDENCE_DIR=/path/to/wsl-evidence');
  console.error('Then verify with:');
  console.error('  node scripts/verify-release-evidence.mjs --macos "$CLI_JAW_MACOS_EVIDENCE_DIR" --wsl "$CLI_JAW_WSL_EVIDENCE_DIR"');
  process.exit(1);
}

const gate = path.join(__dirname, 'verify-release-evidence.mjs');
const result = spawnSync(process.execPath, [gate, '--macos', macosEvidence, '--wsl', wslEvidence], {
  cwd: repoRoot,
  env: process.env,
  encoding: 'utf8',
  stdio: 'inherit',
  shell: false,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('[release-evidence-required] PASS strict fresh-machine release evidence');
