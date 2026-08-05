import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../agent/spawn/process-kill.js';
import {
    runCapabilityProbeWorker,
    type CapabilityProbeRequest,
    type CapabilityProbeResult,
} from './capability-probe-worker.js';

export const CAPABILITY_PROBE_OUTER_DEADLINE_MS = 2_500;

const failure = (reason: CapabilityProbeResult['reason'], timedOut = false): CapabilityProbeResult => ({
    ok: false,
    exitCode: null,
    signal: null,
    timedOut,
    outputLimitExceeded: false,
    reason,
});

function supervisorExecArgv(): string[] {
    const args: string[] = [];
    for (let index = 0; index < process.execArgv.length; index += 1) {
        const arg = process.execArgv[index];
        if (arg === '--eval' || arg === '-e') {
            index += 1;
            continue;
        }
        if (arg) args.push(arg);
    }
    return args;
}

export function probeCodexAppCapability(binary: string): CapabilityProbeResult {
    const controlDir = mkdtempSync(join(tmpdir(), 'cli-jaw-capability-'));
    const controlFile = join(controlDir, 'probe.pid');
    const request: CapabilityProbeRequest = { binary, controlFile };
    const workerPath = fileURLToPath(new URL('./capability-probe-worker.js', import.meta.url));
    const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
    try {
        const result = spawnSync(process.execPath, [...supervisorExecArgv(), workerPath], {
            encoding: 'utf8',
            timeout: CAPABILITY_PROBE_OUTER_DEADLINE_MS,
            killSignal: 'SIGKILL',
            maxBuffer: 16 * 1024,
            env: { ...process.env, CLI_JAW_CAPABILITY_PROBE_REQUEST: encoded },
            stdio: ['ignore', 'pipe', 'ignore'],
        });

        if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
            // The control file lets the outer bound clean the actual detached
            // probe even when the supervisor itself wedges before replying.
            let pid = 0;
            try { pid = Number.parseInt(readFileSync(controlFile, 'utf8'), 10); } catch { /* worker may not have spawned yet */ }
            if (Number.isInteger(pid) && pid > 0) {
                if (process.platform === 'win32') {
                    killProcessTree(pid, 'SIGKILL');
                } else {
                    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
                }
            }
            return failure('supervisor-timeout', true);
        }

        const line = result.stdout.trim().split('\n').at(-1);
        if (!line) return failure('protocol-error');
        try {
            return JSON.parse(line) as CapabilityProbeResult;
        } catch {
            return failure('protocol-error');
        }
    } finally {
        rmSync(controlDir, { recursive: true, force: true });
    }
}

export function probeCodexAppCapabilityAsync(
    binary: string,
    options: Omit<CapabilityProbeRequest, 'binary'> = {},
): Promise<CapabilityProbeResult> {
    return runCapabilityProbeWorker({ binary, ...options });
}

export type { CapabilityProbeRequest, CapabilityProbeResult } from './capability-probe-worker.js';
