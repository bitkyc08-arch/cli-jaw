#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const npm = isWin ? 'npm.cmd' : 'npm';

function commandExists(command) {
  const probe = isWin
    ? spawnSync('where', [command], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], { stdio: 'ignore' });
  return probe.status === 0;
}

function run(label, command, args, options = {}) {
  if (options.skip) {
    console.log(`[install-risk] SKIP ${label}: ${options.skip}`);
    return true;
  }

  console.log(`[install-risk] RUN  ${label}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });

  if (result.status === 0) {
    console.log(`[install-risk] PASS ${label}`);
    return true;
  }

  console.error(`[install-risk] FAIL ${label} (exit ${result.status ?? 'signal'})`);
  return false;
}

function runPackageContentsCheck() {
  const label = 'npm package includes installer/verifier scripts and excludes nested frontend output';
  console.log(`[install-risk] RUN  ${label}`);
  const result = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });

  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    console.error(`[install-risk] FAIL ${label} (exit ${result.status ?? 'signal'})`);
    return false;
  }

  let entries;
  try {
    entries = JSON.parse(result.stdout);
  } catch (error) {
    console.error(`[install-risk] FAIL ${label}: npm pack did not return JSON`);
    console.error(String(error));
    return false;
  }

  const files = new Set((entries?.[0]?.files || []).map((entry) => entry.path));
  const required = [
    'scripts/install.sh',
    'scripts/install-wsl.sh',
    'scripts/verify-fresh-install.sh',
    'scripts/collect-fresh-install-evidence.sh',
    'scripts/audit-fresh-install-evidence.mjs',
    'scripts/verify-release-evidence.mjs',
    'scripts/require-release-evidence.mjs',
    'scripts/postinstall-guard.cjs',
  ];
  const missing = required.filter((file) => !files.has(file));
  if (missing.length) {
    console.error(`[install-risk] FAIL ${label}: missing ${missing.join(', ')}`);
    return false;
  }

  const forbiddenPackagePrefixes = [
    'public/public/',
    'public/dist/dist/',
  ];
  const forbidden = [...files]
    .filter((file) => forbiddenPackagePrefixes.some((prefix) => file.startsWith(prefix)))
    .sort();
  if (forbidden.length) {
    const sample = forbidden.slice(0, 10).join(', ');
    const suffix = forbidden.length > 10 ? `, ... (${forbidden.length} total)` : '';
    console.error(`[install-risk] FAIL ${label}: forbidden frontend build output ${sample}${suffix}`);
    return false;
  }

  console.log(`[install-risk] PASS ${label}`);
  return true;
}

function structureVerifierSkipReason() {
  if (!hasBash) return 'bash not available';
  if (!existsSync('structure/verify-counts.sh')) return 'structure verifier not available';
  if (!commandExists('rg')) return 'ripgrep not available';
  if (!existsSync('public/dist')) return 'public/dist build output not available';
  return '';
}

const checks = [];
const hasBash = commandExists('bash');
checks.push(() => run('bash syntax: scripts/install.sh', 'bash', ['-n', 'scripts/install.sh'], {
  skip: hasBash ? '' : 'bash not available',
}));
checks.push(() => run('bash syntax: scripts/install-wsl.sh', 'bash', ['-n', 'scripts/install-wsl.sh'], {
  skip: hasBash ? '' : 'bash not available',
}));
checks.push(() => run('bash syntax: scripts/verify-fresh-install.sh', 'bash', ['-n', 'scripts/verify-fresh-install.sh'], {
  skip: hasBash ? '' : 'bash not available',
}));
checks.push(() => run('bash syntax: scripts/collect-fresh-install-evidence.sh', 'bash', ['-n', 'scripts/collect-fresh-install-evidence.sh'], {
  skip: hasBash ? '' : 'bash not available',
}));
checks.push(() => run('node syntax: scripts/audit-fresh-install-evidence.mjs', process.execPath, ['--check', 'scripts/audit-fresh-install-evidence.mjs']));
checks.push(() => run('node syntax: scripts/verify-release-evidence.mjs', process.execPath, ['--check', 'scripts/verify-release-evidence.mjs']));
checks.push(() => run('node syntax: scripts/require-release-evidence.mjs', process.execPath, ['--check', 'scripts/require-release-evidence.mjs']));
checks.push(() => run('node syntax: scripts/check-cli-bin-links.cjs', process.execPath, ['--check', 'scripts/check-cli-bin-links.cjs']));

checks.push(() => run('installer risk tests', npx, [
  'tsx',
  '--import',
  './tests/setup/test-home.ts',
  '--experimental-test-module-mocks',
  '--test',
  'tests/unit/install-path-contract.test.ts',
  'tests/unit/install-sh-exec.test.ts',
  'tests/unit/fresh-evidence-audit.test.ts',
  'tests/unit/service.test.ts',
  'tests/unit/safe-install.test.ts',
  'tests/unit/postinstall-strict-tools.test.ts',
  'tests/unit/wsl-installer-doctor.test.ts',
  'tests/unit/wsl-installer-exec.test.ts',
]));

checks.push(runPackageContentsCheck);
checks.push(() => run('cli bin link contract', process.execPath, ['scripts/check-cli-bin-links.cjs'], {
  skip: existsSync('dist/bin/cli-jaw.js') ? '' : 'dist build output not available',
}));
checks.push(() => run('electron staged sidecar JWC contract', npm, ['run', 'check:electron-sidecar-jwc'], {
  skip: existsSync('electron/sidecar/server/node_modules/jawcode/package.json') ? '' : 'staged sidecar not bundled',
}));
checks.push(() => run('app icon asset contract', npm, ['run', 'check:app-icons']));

checks.push(() => run('structure line-count sync', 'bash', ['structure/verify-counts.sh'], {
  skip: structureVerifierSkipReason(),
}));

let ok = true;
for (const check of checks) {
  ok = check() && ok;
}

if (!ok) {
  process.exit(1);
}

console.log('[install-risk] ALL PASS');
