import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolveWindowsLaunchSpec, launchArgv, type ResolveDeps } from '../../../core/windows-launch-spec.js';
import { detectCliBinary } from '../../../core/cli-detect.js';
import { mergeEnvWindowsSafe } from '../../spawn-env.js';
import { ownProcess } from '../../spawn/process-kill.js';
import { normalizeNativePermissions } from './permissions.js';
import { configureAcpModel } from './config.js';
import { AcpSession, validateAcpSessionOptions, type AcpSessionOptions } from './session.js';

export interface CursorSessionOptions extends Omit<AcpSessionOptions, 'clientMetadata'> {
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

/** Existing login only. Every failed or aborted startup owns and retires its own child. */
export async function createCursorSession(options: CursorSessionOptions): Promise<AcpSession> {
    validateAcpSessionOptions(options);
    const permissions = normalizeNativePermissions(options.permissions);
    if (!options.binary || typeof options.binary !== 'string') throw new Error('cursor_acp_invalid_binary');
    for (const value of [options.model, options.effort, options.resumeSessionId]) {
        if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 1024)) throw new Error('cursor_acp_invalid_option');
    }
    if (options.signal?.aborted) throw new Error('cursor_acp_acquire_aborted');
    let cwd: string;
    try {
        cwd = realpathSync(options.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error('not_directory');
    } catch { throw new Error('cursor_acp_invalid_cwd'); }
    const windows = (options.platform ?? process.platform) === 'win32';
    const launch = windows ? resolveWindowsLaunchSpec(options.binary, ['acp'], options.launchDeps ?? {
        which: name => detectCliBinary(name).path || null,
    }) : null;
    if (windows && !launch) throw new Error('cursor_acp_launch_unsupported');
    if (options.signal?.aborted) throw new Error('cursor_acp_acquire_aborted');
    const child: ChildProcessWithoutNullStreams = (options.spawnImpl ?? spawn)(launch?.command ?? options.binary,
        launch ? launchArgv(launch) : ['acp'], { cwd, env: launch ? mergeEnvWindowsSafe(options.env, launch.envDelta) : options.env,
            stdio: 'pipe', shell: false, windowsHide: true });
    const owned = ownProcess(child, options.ownedProcessOptions);
    let session: AcpSession | undefined;
    const abort = () => {
        if (session) session.retire(new Error('cursor_acp_acquire_aborted'));
        else owned.terminate('startup-failed');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        if (options.signal?.aborted) { abort(); throw new Error('cursor_acp_acquire_aborted'); }
        session = new AcpSession(child, { permissions, promptTimeoutMs: options.promptTimeoutMs,
            ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
            ...(options.controlTimeoutMs === undefined ? {} : { controlTimeoutMs: options.controlTimeoutMs }),
            ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
            ...(options.registry === undefined ? {} : { registry: options.registry }),
            ...(options.failed === undefined ? {} : { failed: options.failed }),
            clientMetadata: { parameterizedModelPicker: true } });
        await session.start({ cwd, authMethodId: 'cursor_login',
            ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}) });
        await configureAcpModel(session, { model: options.model, effort: options.effort });
        if (options.signal?.aborted || !session.idle) throw new Error('cursor_acp_acquire_aborted');
        return session;
    } catch (error) {
        if (session) {
            try { await session.close(); }
            catch { throw new Error('cursor_acp_startup_cleanup_failed'); }
        } else {
            owned.terminate('startup-failed');
            child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        }
        throw error;
    } finally { options.signal?.removeEventListener('abort', abort); }
}
