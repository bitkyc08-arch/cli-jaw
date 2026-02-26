#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = process.cwd();

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await sleep(300);
  }
  return false;
}

function resolveInstalledPackage(prefix) {
  const candidates = [
    path.join(prefix, 'lib', 'node_modules', 'cli-jaw'),
    path.join(prefix, 'node_modules', 'cli-jaw'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`installed package path not found under prefix: ${prefix}`);
}

async function main() {
  let tarballPath = null;
  let tmp = null;
  let server = null;

  try {
    const packOut = run('npm', ['pack', '--json']);
    const pack = JSON.parse(packOut);
    const tarballName = pack?.[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not return filename');

    tarballPath = path.join(root, tarballName);
    if (!fs.existsSync(tarballPath)) throw new Error(`tarball not found: ${tarballPath}`);

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-fresh-'));
    const prefix = path.join(tmp, 'prefix');
    const jawHome = path.join(tmp, 'jaw-home');
    fs.mkdirSync(prefix, { recursive: true });

    const installEnv = { ...process.env, JAW_SAFE: '1', npm_config_loglevel: 'error' };
    run('npm', ['i', '-g', tarballPath, '--prefix', prefix], { env: installEnv });

    const pkgDir = resolveInstalledPackage(prefix);
    const jawEntry = path.join(pkgDir, 'dist', 'bin', 'cli-jaw.js');
    if (!fs.existsSync(jawEntry)) throw new Error(`cli entry not found: ${jawEntry}`);

    const jawEnv = { ...process.env, CLI_JAW_HOME: jawHome };

    const version = run(process.execPath, [jawEntry, '--version'], { env: jawEnv }).trim();
    if (!version.toLowerCase().includes('cli-jaw')) throw new Error(`unexpected version output: ${version}`);

    const doctorRaw = run(process.execPath, [jawEntry, '--home', jawHome, 'doctor', '--json'], { env: jawEnv });
    const doctor = JSON.parse(doctorRaw);
    if (!Array.isArray(doctor?.checks) || doctor.checks.length === 0) {
      throw new Error('doctor --json returned empty checks');
    }

    const port = 34679;
    server = spawn(process.execPath, [jawEntry, '--home', jawHome, 'serve', '--port', String(port)], {
      cwd: root,
      env: jawEnv,
      stdio: 'pipe',
    });

    const ready = await waitFor(`http://127.0.0.1:${port}/api/session`, 20000);
    if (!ready) throw new Error('server did not become ready in time');

    const cliRes = await fetch(`http://127.0.0.1:${port}/api/cli-status`);
    if (!cliRes.ok) throw new Error(`/api/cli-status HTTP ${cliRes.status}`);
    const cliJson = await cliRes.json();
    const keys = Object.keys(cliJson || {});
    const required = ['claude', 'codex', 'gemini', 'copilot', 'opencode'];
    for (const k of required) {
      if (!keys.includes(k)) throw new Error(`missing cli key in status: ${k}`);
    }

    console.log('[fresh-install-smoke] PASS');
    console.log(`[fresh-install-smoke] version=${version}`);
    console.log(`[fresh-install-smoke] checks=${doctor.checks.length}`);
    console.log(`[fresh-install-smoke] cli-status keys=${keys.join(',')}`);
  } finally {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await sleep(500);
      if (!server.killed) server.kill('SIGKILL');
    }
    if (tarballPath && fs.existsSync(tarballPath)) {
      fs.unlinkSync(tarballPath);
    }
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('[fresh-install-smoke] FAIL');
  console.error(err?.stack || String(err));
  process.exit(1);
});
