/**
 * Shell-free CLI probe execution (#382).
 *
 * Auth/capability probes were calling execFileSync on detector-returned paths,
 * which EINVALs on .cmd shims (Node 20.12+) and reports working CLIs as
 * unauthenticated. This routes every probe through resolveWindowsLaunchSpec +
 * launchArgv - the #367 primitive - so shims run under ComSpec /d /s /c and
 * extensionless absolute paths get PATHEXT-safe resolution.
 *
 * The result is spawnSync-shaped and NEVER throws: callers like agy's
 * runAgyText depend on reading combined stdout+stderr under a nonzero exit
 * (agy prints --help to stderr with status != 0).
 */
import { spawnSync } from 'node:child_process';
import { resolveWindowsLaunchSpec, launchArgv, type ResolveDeps } from './windows-launch-spec.js';
import { decideShellFallback } from './windows-shell-fallback.js';
import { detectCliBinary } from './cli-detect.js';

export type ProbeExecResult = {
    status: number | null;
    stdout: string;
    stderr: string;
    signal: NodeJS.Signals | null;
    error?: Error;
};

export type ProbeExecOptions = {
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    resolveDeps?: ResolveDeps;
    platform?: NodeJS.Platform;
};

export function probeExec(binary: string, args: string[], opts: ProbeExecOptions = {}): ProbeExecResult {
    const platform = opts.platform ?? process.platform;
    let file = binary;
    let argv = args;
    let env = opts.env;
    if (platform === 'win32') {
        // Copy: never mutate a caller-supplied deps object.
        const deps: ResolveDeps = { which: (n) => detectCliBinary(n).path || null, ...(opts.resolveDeps ?? {}) };
        const spec = resolveWindowsLaunchSpec(binary, args, deps);
        if (spec) {
            file = spec.command;
            argv = launchArgv(spec);
            if (Object.keys(spec.envDelta).length > 0) {
                env = { ...(env ?? process.env), ...spec.envDelta };
            }
        } else if (!binary.toLowerCase().endsWith('.exe')) {
            // Not an npm shim and not a direct executable (a plain .cmd/.bat, or
            // an unresolvable name). Probe argv is fixed flags, but the gate is
            // wired anyway - anything that could split one command into two is
            // refused rather than quietly shelled (#367 discipline).
            const decision = decideShellFallback({ argv: args, command: binary });
            if (decision.allowed) {
                file = process.env['ComSpec'] || process.env['COMSPEC'] || 'cmd.exe';
                argv = ['/d', '/s', '/c', binary, ...args];
            }
        }
    }
    const r = spawnSync(file, argv, {
        encoding: 'utf8',
        timeout: opts.timeout ?? 5000,
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env } : {}),
    });
    return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        signal: r.signal ?? null,
        ...(r.error ? { error: r.error } : {}),
    };
}

/**
 * Shared grok auth probe (#382): readiness and the quota route ran the same
 * `grok models` command through separate execFileSync calls. Returns the
 * stdout when the CLI answered with a model list, else null.
 */
export function probeGrokModels(binaryPath: string): string | null {
    const r = probeExec(binaryPath, ['models']);
    if (r.status !== 0) return null;
    return r.stdout.includes('grok-build') || r.stdout.includes('Available models') ? r.stdout : null;
}
