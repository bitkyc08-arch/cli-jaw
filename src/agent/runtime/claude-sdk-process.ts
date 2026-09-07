import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { ownProcess } from '../spawn/process-kill.js';
import { resolveWindowsLaunchSpec, launchArgv, type ResolveDeps } from '../../core/windows-launch-spec.js';
import { detectCliBinary, readProcessPath } from '../../core/cli-detect.js';
import { mergeEnvWindowsSafe } from '../spawn-env.js';
import { ClaudeSdkRoots, type ClaudeRootWaitOptions } from './claude-sdk-roots.js';

/** SDK transport ownership: stderr is drained, and close means observed child exit. */
export function createClaudeProcessOwner(deps: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn; launchDeps?: ResolveDeps; onMultipleRoots?: () => void } = {}) {
    const children = new Set<ChildProcessWithoutNullStreams>();
    const exits: Promise<void>[] = [];
    let closing = false;
    let stderrBytes = 0;
    const roots = new ClaudeSdkRoots(deps.onMultipleRoots);
    return {
        spawn(options: SpawnOptions): ChildProcessWithoutNullStreams {
            if (closing) throw new Error('claude_process_owner_closed');
            if (roots.state.kind === 'multiple') throw new Error('claude_multiple_root_processes');
            const platform = deps.platform ?? process.platform;
            const windows = platform === 'win32';
            const baseEnv = windows ? mergeEnvWindowsSafe(options.env, {}, platform) : options.env;
            const launch = windows ? resolveWindowsLaunchSpec(options.command, options.args,
                { which: name => detectCliBinary(name, readProcessPath(baseEnv)).path || null, ...deps.launchDeps }) : null;
            if (windows && !launch) throw new Error('claude_windows_launch_unsupported');
            const child = (deps.spawnImpl ?? spawn)(launch?.command ?? options.command, launch ? launchArgv(launch) : options.args, {
                ...(options.cwd ? { cwd: options.cwd } : {}), env: launch ? mergeEnvWindowsSafe(baseEnv, launch.envDelta, platform) : baseEnv,
                stdio: 'pipe', shell: false, windowsHide: true,
            });
            children.add(child);
            const owner = ownProcess(child);
            const consume = (chunk: Buffer) => { stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.length); };
            const abort = () => owner.terminate('cancel');
            child.stderr.on('data', consume);
            // SDK owns stdin/stdout parsing; a closed pipe must not become an unhandled error.
            const ioError = () => owner.terminate('startup-failed');
            child.stdin.on('error', ioError); child.stdout.on('error', ioError); child.stderr.on('error', ioError);
            options.signal.addEventListener('abort', abort, { once: true });
            if (options.signal.aborted) abort();
            exits.push(new Promise<void>(resolve => {
                child.once('error', () => owner.terminate('startup-failed'));
                child.once('close', () => {
                    children.delete(child); options.signal.removeEventListener('abort', abort);
                    child.stderr.off('data', consume);
                    child.stdin.off('error', ioError); child.stdout.off('error', ioError); child.stderr.off('error', ioError);
                    resolve();
                });
            }));
            roots.track(child);
            return child;
        },
        terminate(): void {
            closing = true;
            roots.close();
            for (const child of children) ownProcess(child).terminate('cancel');
        },
        async wait(): Promise<void> { await Promise.all(exits); },
        get stderrBytes() { return stderrBytes; },
        get activeCount() { return children.size; },
        get primaryChild() { return roots.primary; },
        get rootProcessState() { return roots.state; },
        waitForPrimaryChild: (options?: ClaudeRootWaitOptions) => roots.wait(options),
    };
}
