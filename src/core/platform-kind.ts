/**
 * Canonical platform classification for cli-jaw.
 *
 * Single source of truth for "am I on native Windows / in WSL / on plain
 * Linux". Every rule takes its inputs as parameters so the whole matrix is
 * testable on one CI OS.
 *
 * Design rationale and primary sources:
 * devlog/_plan/260805_windows_native_detection/001_platform_signal_research.md
 */
import fs from 'node:fs';
import os from 'node:os';

export type PlatformKind = 'windows-native' | 'wsl' | 'linux' | 'darwin' | 'other';

export interface PlatformProbes {
    /** Reads a file as UTF-8, or returns null when unreadable. */
    readText(path: string): string | null;
    /** True when the path exists. */
    exists(path: string): boolean;
    /** Kernel release string, e.g. os.release(). */
    release(): string;
}

export const defaultPlatformProbes: PlatformProbes = {
    readText(path) {
        try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
    },
    exists(path) {
        try { return fs.existsSync(path); } catch { return false; }
    },
    release() {
        try { return os.release(); } catch { return ''; }
    },
};

/**
 * WSL markers that only ever exist inside a WSL *Linux* process.
 *
 * WSLENV is deliberately absent: Microsoft documents it as shared with the
 * Windows host (it is what configures env-var translation across the
 * boundary), so testing it misclassifies native Windows as WSL.
 */
const WSL_ENV_KEYS = ['WSL_DISTRO_NAME', 'WSL_INTEROP'] as const;
const WSL_PATH_MARKERS = ['/run/WSL', '/proc/sys/fs/binfmt_misc/WSLInterop'] as const;

function hasWslEnvMarker(env: NodeJS.ProcessEnv): boolean {
    return WSL_ENV_KEYS.some((key) => !!env[key]);
}

function hasWslPathMarker(probes: PlatformProbes): boolean {
    return WSL_PATH_MARKERS.some((markerPath) => probes.exists(markerPath));
}

function hasWslKernelMarker(probes: PlatformProbes): boolean {
    // `||` not `??`: an unreadable probe returns null, but a mounted-but-empty
    // /proc under a restricted container returns '', and both must fall
    // through to os.release().
    const osrelease = probes.readText('/proc/sys/kernel/osrelease')?.trim() || probes.release();
    if (osrelease.toLowerCase().includes('microsoft')) return true;
    const version = probes.readText('/proc/version');
    return !!version && version.toLowerCase().includes('microsoft');
}

export function resolvePlatformKind(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    probes: PlatformProbes = defaultPlatformProbes,
): PlatformKind {
    // STRICT: a win32 process is a Win32 binary. WSL env vars leaking in from
    // the host (WSLENV, or anything a user exported) can never change this.
    if (platform === 'win32') return 'windows-native';
    if (platform === 'darwin') return 'darwin';
    if (platform !== 'linux') return 'other';

    if (hasWslEnvMarker(env) || hasWslPathMarker(probes) || hasWslKernelMarker(probes)) {
        return 'wsl';
    }
    return 'linux';
}

/**
 * Takes only `platform` on purpose: adding env inputs would reintroduce the
 * exact class of bug this module exists to prevent.
 */
export function isWindowsNative(
    platform: NodeJS.Platform = process.platform,
): boolean {
    return platform === 'win32';
}

export function isWsl(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    probes: PlatformProbes = defaultPlatformProbes,
): boolean {
    return resolvePlatformKind(platform, env, probes) === 'wsl';
}

/**
 * True when a Win32 process appears to have been launched from a WSL shell,
 * i.e. Windows Node running against a WSL working directory. Global npm
 * installs then land on the Windows side rather than in the distro.
 *
 * Keyed on the working directory, not the environment. A Win32 process started
 * from inside a distro has its cwd on the WSL filesystem, which Windows spells
 * as the UNC prefix `\\wsl$\<distro>` or `\\wsl.localhost\<distro>`. Every
 * environment variable is ambiguous here: native Windows with interop
 * configured and Windows-Node-from-WSL both carry WSLENV.
 *
 * Both parameters are required. There is no useful default: inside an npm
 * lifecycle script `process.cwd()` is the installed package root, not where
 * the user ran npm. Use `resolveInvocationCwd()` to obtain the right value.
 *
 * This is a HEURISTIC, and weaker than resolvePlatformKind's taxonomy. Two
 * known holes, both inherent to a cwd-based signal:
 *   - false negative: the user cd's to a Windows path (e.g. /mnt/c/src) inside
 *     a WSL shell before invoking npm, so the cwd is an ordinary drive path;
 *   - false positive: a native PowerShell session whose cwd is a \\wsl$ share.
 *
 * Do not describe this function as strict. The strictness guarantee belongs to
 * resolvePlatformKind, which can never confuse windows-native with wsl; this
 * only decides whether to print an advisory warning.
 */
export function isWindowsNodeLaunchedFromWsl(
    platform: NodeJS.Platform,
    cwd: string,
): boolean {
    if (platform !== 'win32') return false;
    if (!cwd) return false;
    const normalized = cwd.replace(/\//g, '\\').toLowerCase();
    return normalized.startsWith('\\\\wsl$\\') || normalized.startsWith('\\\\wsl.localhost\\');
}

/**
 * The directory the user actually invoked the command from.
 *
 * npm sets INIT_CWD to the directory where `npm` was originally run, while the
 * lifecycle script itself executes from the package root. Outside an npm
 * lifecycle INIT_CWD is absent and process.cwd() is already correct.
 */
export function resolveInvocationCwd(env: NodeJS.ProcessEnv = process.env): string {
    const initCwd = env['INIT_CWD'];
    if (initCwd && initCwd.trim()) return initCwd;
    try { return process.cwd(); } catch { return ''; }
}
