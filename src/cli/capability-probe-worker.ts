import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { killProcessTree, killProcessTreeIfAlive } from '../agent/spawn/process-kill.js';

export const CAPABILITY_PROBE_DEADLINE_MS = 1_500;
export const CAPABILITY_PROBE_KILL_GRACE_MS = 250;
export const CAPABILITY_PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface CapabilityProbeRequest {
    binary: string;
    platform?: NodeJS.Platform;
    controlFile?: string;
}

export type CapabilityProbeReason =
    | 'ready'
    | 'exit-nonzero'
    | 'timeout'
    | 'output-limit'
    | 'spawn-error'
    | 'supervisor-timeout'
    | 'protocol-error';

export interface CapabilityProbeResult {
    ok: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    outputLimitExceeded: boolean;
    reason: CapabilityProbeReason;
}

export interface CapabilitySpawnSpec {
    command: string;
    args: string[];
    options: SpawnOptions;
}

export function buildCapabilitySpawnSpec(
    request: CapabilityProbeRequest,
    env: NodeJS.ProcessEnv = process.env,
): CapabilitySpawnSpec {
    const platform = request.platform ?? process.platform;
    const isCmdShim = platform === 'win32' && !request.binary.toLowerCase().endsWith('.exe');
    return {
        command: request.binary,
        args: ['app-server', '--help'],
        options: {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: platform !== 'win32',
            ...(isCmdShim ? { shell: true } : {}),
        },
    };
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') return;
    try { process.kill(-pid, signal); } catch { /* already exited or no process group */ }
}

function terminateProbe(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    // The detached group closes descendants that outlive the direct child. The
    // shared tree helper remains the canonical recursive-PID cleanup owner.
    killProcessTree(child.pid, signal);
    killProcessGroup(child.pid, signal);
}

export function runCapabilityProbeWorker(request: CapabilityProbeRequest): Promise<CapabilityProbeResult> {
    return new Promise((resolve) => {
        const spec = buildCapabilitySpawnSpec(request);
        let child: ChildProcess;
        let settled = false;
        let timedOut = false;
        let outputLimitExceeded = false;
        let outputBytes = 0;
        let deadlineTimer: NodeJS.Timeout | undefined;
        let escalationTimer: NodeJS.Timeout | undefined;
        let hardFinishTimer: NodeJS.Timeout | undefined;

        const finish = (result: CapabilityProbeResult): void => {
            if (settled) return;
            settled = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (escalationTimer) clearTimeout(escalationTimer);
            if (hardFinishTimer) clearTimeout(hardFinishTimer);
            resolve(result);
        };

        const failureResult = (reason: CapabilityProbeReason): CapabilityProbeResult => ({
            ok: false,
            exitCode: child.exitCode,
            signal: child.signalCode,
            timedOut,
            outputLimitExceeded,
            reason,
        });

        const stop = (reason: 'timeout' | 'output-limit'): void => {
            if (timedOut || outputLimitExceeded) return;
            if (reason === 'timeout') timedOut = true;
            else outputLimitExceeded = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            terminateProbe(child, 'SIGTERM');
            escalationTimer = setTimeout(() => {
                killProcessTreeIfAlive(child);
                if (child.pid) killProcessGroup(child.pid, 'SIGKILL');
            }, CAPABILITY_PROBE_KILL_GRACE_MS);
            escalationTimer.unref();
            // A descendant can keep a pipe open even after the direct child exits.
            // Resolve independently of `close`; the outer supervisor is the final bound.
            hardFinishTimer = setTimeout(() => finish(failureResult(reason)), CAPABILITY_PROBE_KILL_GRACE_MS + 100);
            hardFinishTimer.unref();
        };

        try {
            child = spawn(spec.command, spec.args, spec.options);
            if (request.controlFile && child.pid) {
                writeFileSync(request.controlFile, String(child.pid), { encoding: 'utf8', mode: 0o600 });
            }
        } catch {
            finish({
                ok: false,
                exitCode: null,
                signal: null,
                timedOut: false,
                outputLimitExceeded: false,
                reason: 'spawn-error',
            });
            return;
        }

        deadlineTimer = setTimeout(() => stop('timeout'), CAPABILITY_PROBE_DEADLINE_MS);
        deadlineTimer.unref();

        const onOutput = (chunk: Buffer | string): void => {
            outputBytes += Buffer.byteLength(chunk);
            if (outputBytes > CAPABILITY_PROBE_OUTPUT_LIMIT_BYTES && !outputLimitExceeded && !timedOut) {
                stop('output-limit');
            }
        };
        child.stdout?.on('data', onOutput);
        child.stderr?.on('data', onOutput);
        child.once('error', () => finish(failureResult('spawn-error')));
        child.once('close', (code, signal) => {
            if (timedOut) finish(failureResult('timeout'));
            else if (outputLimitExceeded) finish(failureResult('output-limit'));
            else finish({
                ok: code === 0,
                exitCode: code,
                signal,
                timedOut: false,
                outputLimitExceeded: false,
                reason: code === 0 ? 'ready' : 'exit-nonzero',
            });
        });
    });
}

async function runSupervisorEntrypoint(): Promise<void> {
    const encoded = process.env['CLI_JAW_CAPABILITY_PROBE_REQUEST'];
    if (!encoded) return;
    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<CapabilityProbeRequest>;
        if (typeof parsed.binary !== 'string' || parsed.binary.length === 0) throw new Error('invalid binary');
        if (parsed.platform !== undefined && !['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'].includes(parsed.platform)) {
            throw new Error('invalid platform');
        }
        const request: CapabilityProbeRequest = {
            binary: parsed.binary,
            ...(parsed.platform !== undefined ? { platform: parsed.platform } : {}),
            ...(typeof parsed.controlFile === 'string' ? { controlFile: parsed.controlFile } : {}),
        };
        const result = await runCapabilityProbeWorker(request);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = result.ok ? 0 : 1;
    } catch {
        const result: CapabilityProbeResult = {
            ok: false,
            exitCode: null,
            signal: null,
            timedOut: false,
            outputLimitExceeded: false,
            reason: 'protocol-error',
        };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = 1;
    }
}

const entrypoint = basename(process.argv[1] ?? '');
if (entrypoint === 'capability-probe-worker.js' || entrypoint === 'capability-probe-worker.ts') {
    void runSupervisorEntrypoint();
}
