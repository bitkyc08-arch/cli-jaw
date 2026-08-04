import { fork, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extname } from 'node:path';
import { detectAllCli } from '../core/cli-detection.js';
import { readClaudeCreds, readCodexTokens } from '../routes/quota.js';
import { hasCopilotAuthSync } from '../../lib/quota-copilot.js';
import { killProcessTree, killProcessTreeIfAlive } from '../agent/spawn/process-kill.js';
import { probeCodexAppCapabilityAsync } from './capability-probe.js';
import type { CliStatusRow, CliStatusSnapshot } from './cli-status.js';
import { CLI_KEYS } from './registry.js';

const WORKER_OUTER_TIMEOUT_MS = 60_000;
const WORKER_KILL_GRACE_MS = 250;
const CHILD_MARKER = '--cli-status-worker-child';
const OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface CliStatusWorkerOptions {
    timeoutMs?: number;
    workerPath?: string;
    env?: NodeJS.ProcessEnv;
}

type AuthResult = { authenticated: boolean; source: string };
type CapabilityResult = { ready: boolean; reason?: string };

function defaultWorkerPath(): string {
    const extension = extname(fileURLToPath(import.meta.url));
    return fileURLToPath(new URL(`./cli-status-worker${extension}`, import.meta.url));
}

function workerExecArgv(): string[] {
    const args: string[] = [];
    for (let index = 0; index < process.execArgv.length; index += 1) {
        const arg = process.execArgv[index];
        if (arg === '--eval' || arg === '-e' || arg === '--print' || arg === '-p') {
            index += 1;
            continue;
        }
        if (arg === '--input-type' || arg?.startsWith('--input-type=')) {
            if (arg === '--input-type') index += 1;
            continue;
        }
        if (arg) args.push(arg);
    }
    return args;
}

function terminateWorker(child: ReturnType<typeof fork>): void {
    if (!child.pid) return;
    if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group may not exist */ }
    }
    killProcessTree(child.pid, 'SIGTERM');
    const escalation = setTimeout(() => {
        if (process.platform !== 'win32' && child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        killProcessTreeIfAlive(child, child.pid);
    }, WORKER_KILL_GRACE_MS);
    escalation.unref();
}

function isSnapshot(value: unknown): value is CliStatusSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const snapshot = value as Record<string, unknown>;
    return CLI_KEYS.every((cli) => {
        const row = snapshot[cli];
        if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
        const record = row as Record<string, unknown>;
        return (typeof record['available'] === 'boolean' || record['available'] === null)
            && (typeof record['binaryInstalled'] === 'boolean' || record['binaryInstalled'] === null)
            && (typeof record['capabilityReady'] === 'boolean' || record['capabilityReady'] === null)
            && (typeof record['authenticated'] === 'boolean' || record['authenticated'] === null)
            && (typeof record['path'] === 'string' || record['path'] === null)
            && typeof record['source'] === 'string'
            && ['checking', 'fresh', 'stale'].includes(String(record['probeState']));
    });
}

export function runCliStatusWorker(options: CliStatusWorkerOptions = {}): Promise<CliStatusSnapshot> {
    const workerPath = options.workerPath ?? defaultWorkerPath();
    const child = fork(workerPath, options.workerPath ? [] : [CHILD_MARKER], {
        detached: process.platform !== 'win32',
        env: options.env ?? process.env,
        execArgv: workerExecArgv(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | null, snapshot?: CliStatusSnapshot): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            child.removeAllListeners();
            if (error) reject(error);
            else resolve(snapshot!);
        };
        const timeout = setTimeout(() => {
            terminateWorker(child);
            finish(new Error(`CLI status worker exceeded ${options.timeoutMs ?? WORKER_OUTER_TIMEOUT_MS}ms`));
        }, options.timeoutMs ?? WORKER_OUTER_TIMEOUT_MS);
        timeout.unref();

        child.once('error', (error) => finish(error));
        child.once('exit', (code, signal) => {
            if (!settled) finish(new Error(`CLI status worker exited before result (${code ?? signal ?? 'unknown'})`));
        });
        child.once('message', (message: unknown) => {
            const payload = message as { ok?: unknown; snapshot?: unknown; error?: unknown };
            if (payload?.ok === true && isSnapshot(payload.snapshot)) {
                finish(null, payload.snapshot);
                return;
            }
            finish(new Error(typeof payload?.error === 'string' ? payload.error : 'Invalid CLI status worker response'));
        });
    });
}

function runCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean; outputLimited: boolean }> {
    return new Promise((resolve) => {
        const child = spawn(binary, args, {
            detached: process.platform !== 'win32',
            shell: process.platform === 'win32' && !binary.toLowerCase().endsWith('.exe'),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let bytes = 0;
        let timedOut = false;
        let outputLimited = false;
        let settled = false;

        const finish = (code: number | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, output, timedOut, outputLimited });
        };
        const onData = (chunk: Buffer): void => {
            if (outputLimited) return;
            bytes += chunk.byteLength;
            if (bytes > OUTPUT_LIMIT_BYTES) {
                outputLimited = true;
                if (child.pid) killProcessTree(child.pid, 'SIGTERM');
                finish(null);
                return;
            }
            output += chunk.toString('utf8');
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.once('error', () => finish(null));
        child.once('exit', (code) => finish(code));
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid, 'SIGTERM');
            const escalation = setTimeout(() => killProcessTreeIfAlive(child, child.pid), WORKER_KILL_GRACE_MS);
            escalation.unref();
            finish(null);
        }, timeoutMs);
        timer.unref();
    });
}

async function probeCodexApp(binary: string): Promise<CapabilityResult> {
    const result = await probeCodexAppCapabilityAsync(binary);
    return result.ok ? { ready: true } : { ready: false, reason: `app-server ${result.reason}` };
}

async function authForCli(cli: string, path: string | null, detected: Record<string, { available?: boolean }>): Promise<AuthResult> {
    switch (cli) {
        case 'agy': return { authenticated: true, source: 'installed; auth checked by agy at run time' };
        case 'ai-e': return { authenticated: true, source: 'provider-delegated' };
        case 'pi': return { authenticated: true, source: 'profile auth validated at registration' };
        case 'claude': {
            const creds = readClaudeCreds();
            return { authenticated: Boolean(creds?.token) || creds?.source === 'cloud-provider-env', source: creds?.source ?? 'none' };
        }
        case 'codex':
        case 'codex-app': {
            const authenticated = Boolean(readCodexTokens()?.access_token);
            return { authenticated, source: authenticated ? 'auth.json' : 'none' };
        }
        case 'cursor': {
            if (process.env['CURSOR_API_KEY']) return { authenticated: true, source: 'CURSOR_API_KEY' };
            const result = await runCommand(path || 'cursor-agent', ['status'], 5_000);
            const authenticated = result.code === 0 && /logged in|authenticated/i.test(result.output);
            return { authenticated, source: authenticated ? 'cursor-agent status' : 'none' };
        }
        case 'kiro-code': {
            const result = await runCommand(path || 'kiro-cli', ['whoami'], 5_000);
            const authenticated = result.code === 0 && /logged in|email:/i.test(result.output);
            return { authenticated, source: authenticated ? 'kiro-cli whoami' : 'none' };
        }
        case 'grok': {
            const result = await runCommand(path || 'grok', ['models'], 5_000);
            const authenticated = result.code === 0 && /grok-build|Available models/.test(result.output);
            return { authenticated, source: authenticated ? 'grok models' : 'none' };
        }
        case 'copilot': {
            const authenticated = hasCopilotAuthSync();
            return { authenticated, source: authenticated ? 'local-auth-chain' : 'none' };
        }
        case 'claude-e': {
            if (!detected['claude']?.available) return { authenticated: false, source: 'underlying claude missing' };
            const creds = readClaudeCreds();
            return { authenticated: Boolean(creds?.token) || creds?.source === 'cloud-provider-env', source: creds?.source ?? 'none' };
        }
        case 'opencode': return { authenticated: true, source: 'installed' };
        default: return { authenticated: false, source: 'none' };
    }
}

export async function collectCliStatus(): Promise<CliStatusSnapshot> {
    const detected = detectAllCli() as Record<string, { available?: boolean; path?: string | null }>;
    const rows = await Promise.all(Object.entries(detected).map(async ([cli, info]) => {
        const binaryInstalled = Boolean(info.available);
        const path = typeof info.path === 'string' ? info.path : null;
        let capability: CapabilityResult = { ready: binaryInstalled };
        if (cli === 'codex-app' && binaryInstalled && path) capability = await probeCodexApp(path);
        const auth = binaryInstalled
            ? await authForCli(cli, path, detected)
            : { authenticated: false, source: 'none' };
        const row: CliStatusRow = {
            available: binaryInstalled && capability.ready,
            binaryInstalled,
            capabilityReady: capability.ready,
            authenticated: auth.authenticated,
            path,
            source: auth.source,
            probeState: 'fresh',
            ...(capability.reason ? { reason: capability.reason } : {}),
        };
        return [cli, row] as const;
    }));
    return Object.fromEntries(rows);
}

async function runChild(): Promise<void> {
    try {
        process.send?.({ ok: true, snapshot: await collectCliStatus() });
    } catch (error) {
        process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
        process.disconnect?.();
    }
}

if (process.argv.includes(CHILD_MARKER)) void runChild();

/** Fixture helper for tests that need a standalone worker URL. */
export function cliStatusWorkerUrl(): URL {
    return pathToFileURL(defaultWorkerPath());
}
