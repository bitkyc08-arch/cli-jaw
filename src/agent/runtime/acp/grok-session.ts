import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolveWindowsLaunchSpec, launchArgv, type ResolveDeps } from '../../../core/windows-launch-spec.js';
import { detectCliBinary } from '../../../core/cli-detect.js';
import { mergeEnvWindowsSafe } from '../../spawn-env.js';
import { ownProcess } from '../../spawn/process-kill.js';
import { normalizeNativePermissions } from './permissions.js';
import { AcpSession, acpRecord, validateAcpSessionOptions, type AcpSessionOptions } from './session.js';
import { grokAcpArgs, grokAuthMethod, grokModelSelection } from './grok-options.js';

export interface GrokSessionOptions extends Omit<AcpSessionOptions, 'clientMetadata'> {
    binary: string;
    env: NodeJS.ProcessEnv;
    cwd: string;
    model?: string | null;
    effort?: string | null;
    resumeSessionId?: string | null;
    signal?: AbortSignal;
    spawnImpl?: typeof spawn;
    platform?: NodeJS.Platform;
    launchDeps?: ResolveDeps;
}

const STARTUP_REAP_TIMEOUT_MS = 6_000;

/** Startup can be aborted before an AcpSession exists to own close(). */
async function reapStartupChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('exit', exited); child.off('close', exited); };
        const exited = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('grok_acp_startup_cleanup_failed')); }, STARTUP_REAP_TIMEOUT_MS);
        child.once('exit', exited); child.once('close', exited);
    });
}

/** One dedicated Grok process, with existing auth/config and no print fallback. */
export async function createGrokSession(options: GrokSessionOptions): Promise<AcpSession> {
    // Capture the requested identity before any async provider setup begins.
    const { model, effort, resumeSessionId } = options;
    validateAcpSessionOptions(options);
    const permissions = normalizeNativePermissions(options.permissions);
    const args = grokAcpArgs(permissions); // Policy admission must precede spawn, auth and session setup.
    if (typeof options.binary !== 'string' || !options.binary.trim()) throw new Error('grok_acp_invalid_binary');
    for (const value of [model, effort, resumeSessionId]) {
        if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 1024
            || (value.length > 0 && !value.trim()))) throw new Error('grok_acp_invalid_option');
    }
    if (options.signal?.aborted) throw new Error('grok_acp_acquire_aborted');
    let cwd: string;
    try {
        cwd = realpathSync(options.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error('not_directory');
    } catch { throw new Error('grok_acp_invalid_cwd'); }
    const env = { ...options.env };
    const windows = (options.platform ?? process.platform) === 'win32';
    const launch = windows ? resolveWindowsLaunchSpec(options.binary, args, options.launchDeps ?? {
        which: name => detectCliBinary(name).path || null,
    }) : null;
    if (windows && !launch) throw new Error('grok_acp_launch_unsupported');
    if (options.signal?.aborted) throw new Error('grok_acp_acquire_aborted');
    const child: ChildProcessWithoutNullStreams = (options.spawnImpl ?? spawn)(launch?.command ?? options.binary,
        launch ? launchArgv(launch) : args, { cwd, env: launch ? mergeEnvWindowsSafe(env, launch.envDelta) : env,
            stdio: 'pipe', shell: false, windowsHide: true });
    const owned = ownProcess(child, options.ownedProcessOptions);
    let session: AcpSession | undefined;
    const abort = () => {
        if (session) session.retire(new Error('grok_acp_acquire_aborted'));
        else owned.terminate('startup-failed');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        if (options.signal?.aborted) { abort(); throw new Error('grok_acp_acquire_aborted'); }
        session = new AcpSession(child, { permissions, promptTimeoutMs: options.promptTimeoutMs,
            ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
            ...(options.controlTimeoutMs === undefined ? {} : { controlTimeoutMs: options.controlTimeoutMs }),
            ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
            ...(options.ownedProcessOptions === undefined ? {} : { ownedProcessOptions: options.ownedProcessOptions }),
            ...(options.registry === undefined ? {} : { registry: options.registry }),
            ...(options.failed === undefined ? {} : { failed: options.failed }) });
        await session.start({ cwd, authMethodId: init => grokAuthMethod(env, init['authMethods']),
            ...(resumeSessionId ? { resumeSessionId } : {}) });
        const setup = session.getSessionSetup();
        const selected = grokModelSelection(setup, model, effort);
        // Preserve the provider's current effort when only a product alias was requested.
        if (selected.meta || selected.modelId !== acpRecord(setup['models'])['currentModelId']) {
            await session.setModel(selected.modelId, selected.meta);
        }
        if (options.signal?.aborted || !session.idle) throw new Error('grok_acp_acquire_aborted');
        return session;
    } catch (error) {
        if (session) {
            try { await session.close(); }
            catch { throw new Error('grok_acp_startup_cleanup_failed'); }
        } else {
            owned.terminate('startup-failed');
            try { await reapStartupChild(child); }
            finally { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); }
        }
        throw error;
    } finally { options.signal?.removeEventListener('abort', abort); }
}
