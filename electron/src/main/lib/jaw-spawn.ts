import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RingBuffer } from './ring-buffer.js';

let pathFixed = false;
async function ensureFixedPath(): Promise<void> {
  if (pathFixed) return;
  pathFixed = true;
  try {
    const mod = await import('fix-path');
    const fn = (mod as unknown as { default?: () => void }).default ?? (mod as unknown as () => void);
    if (typeof fn === 'function') fn();
  } catch {
    // fix-path is optional; ignore in dev
  }
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichJawCandidates(): string[] {
  try {
    const command = process.platform === 'win32' ? 'where' : 'which';
    const args = process.platform === 'win32' ? ['jaw'] : ['-a', 'jaw'];
    const out = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // not found
  }
  return [];
}

function commandOutputFromError(error: unknown): string {
  const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString('utf8') : String(err.stdout ?? '');
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : String(err.stderr ?? '');
  const message = typeof err.message === 'string' ? err.message : '';
  return `${stdout}\n${stderr}\n${message}`;
}

export function hasDashboardCommand(binary: string): boolean {
  if (!isExecutable(binary)) return false;
  try {
    execFileSync(binary, ['dashboard', '__jaw_electron_probe__'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    });
    return true;
  } catch (error) {
    const output = commandOutputFromError(error);
    return (
      output.includes('Unknown dashboard command: __jaw_electron_probe__') ||
      output.includes('Usage: jaw dashboard') ||
      output.includes('jaw dashboard serve')
    );
  }
}

function addCandidate(candidate: string, searched: string[], seen: Set<string>, label = candidate): string | null {
  if (seen.has(candidate)) return null;
  seen.add(candidate);
  if (!isExecutable(candidate)) {
    searched.push(`${label} (not executable)`);
    return null;
  }
  if (!hasDashboardCommand(candidate)) {
    searched.push(`${label} (no dashboard support)`);
    return null;
  }
  searched.push(label);
  return candidate;
}

function expandNvmCandidates(): string[] {
  const out: string[] = [];
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
  if (!existsSync(nvmDir)) return out;
  try {
    for (const ver of readdirSync(nvmDir)) {
      out.push(join(nvmDir, ver, 'bin', 'jaw'));
    }
  } catch {
    // ignore
  }
  return out;
}

function buildCandidateList(): string[] {
  const cands: string[] = [];
  if (process.env.JAW_BIN) cands.push(process.env.JAW_BIN);
  cands.push('/opt/homebrew/bin/jaw');
  cands.push('/usr/local/bin/jaw');
  cands.push(...expandNvmCandidates());
  cands.push(join(homedir(), '.volta', 'bin', 'jaw'));
  cands.push(join(homedir(), '.fnm', 'aliases', 'default', 'bin', 'jaw'));
  cands.push(join(homedir(), '.fnm', 'current', 'bin', 'jaw'));
  return cands;
}

export interface FindResult {
  path: string | null;
  searched: string[];
}

export async function findJawBinary(): Promise<FindResult> {
  await ensureFixedPath();
  const searched: string[] = [];
  const seen = new Set<string>();

  if (process.env.JAW_BIN) {
    const found = addCandidate(process.env.JAW_BIN, searched, seen, `$JAW_BIN=${process.env.JAW_BIN}`);
    if (found) return { path: found, searched };
  }

  const whichCandidates = whichJawCandidates();
  if (whichCandidates.length === 0) searched.push('which -a jaw → (not found)');
  for (const c of whichCandidates) {
    const found = addCandidate(c, searched, seen, `which -a jaw → ${c}`);
    if (found) return { path: found, searched };
  }

  for (const c of buildCandidateList()) {
    const found = addCandidate(c, searched, seen);
    if (found) return { path: found, searched };
  }

  return { path: null, searched };
}

export interface SpawnOptions {
  port: number;
  ringBuffer: RingBuffer;
  env?: NodeJS.ProcessEnv;
}

export function spawnJawDashboard(
  binary: string,
  opts: SpawnOptions,
): ChildProcess {
  const child = spawn(binary, ['dashboard', 'serve', '--port', String(opts.port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env ?? {}) },
    detached: false,
  });
  child.stdout?.on('data', (d) => opts.ringBuffer.append(d));
  child.stderr?.on('data', (d) => opts.ringBuffer.append(d));
  return child;
}

export async function gracefulShutdown(
  child: ChildProcess,
  timeoutMs = 5000,
): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (done) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish();
    }, timeoutMs);
  });
}
