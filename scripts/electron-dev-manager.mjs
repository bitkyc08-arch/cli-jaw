#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const port = Number(process.env.JAW_DASHBOARD_PORT || '24576');
const healthUrl = `http://127.0.0.1:${port}/api/dashboard/health`;

function waitUntilTerminated() {
  return new Promise((resolve) => {
    const done = () => resolve(undefined);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

async function isExistingManagerOnline() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.service === 'manager-dashboard';
  } catch {
    return false;
  }
}

async function main() {
  if (await isExistingManagerOnline()) {
    console.log(`Jaw Manager already running on ${healthUrl}; attaching Electron dev shell.`);
    await waitUntilTerminated();
    return;
  }

  const cli = join(projectRoot, 'dist', 'bin', 'cli-jaw.js');
  const child = spawn(process.execPath, [cli, 'dashboard', 'serve', '--port', String(port)], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });

  const stop = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[electron-dev-manager] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
