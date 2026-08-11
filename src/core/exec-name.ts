/**
 * Windows child-process launch resolution.
 *
 * Two separate Windows facts have to be handled together, and handling only
 * the first is what made the initial #274 fix incomplete:
 *
 * 1. A bare name resolves on PATH only with a launchable extension. npm ships
 *    as `npm.cmd`, so `execFileSync('npm', ...)` fails with a bare ENOENT on a
 *    machine where npm is installed and working. Confirmed on the reporting
 *    host: `spawnSync('npm',['--version'])` -> ENOENT, with `shell:true` ->
 *    11.17.0.
 * 2. A `.cmd`/`.bat` file is a script interpreted by cmd.exe, not an
 *    executable image. Since the CVE-2024-27980 hardening, Node refuses to run
 *    one through `execFile`/`spawn` without a shell. So renaming `npm` to
 *    `npm.cmd` and still calling execFileSync just trades ENOENT for EINVAL.
 *
 * The launch spec below therefore routes batch scripts through
 * `%ComSpec% /d /s /c`, which is the documented non-shell-injection way to run
 * one: arguments stay a real argv array, so there is no shell-metacharacter
 * exposure and no DEP0190 argument-concatenation warning.
 */

/**
 * Deliberately npm-only. Other tools ship differently and a speculative list
 * would introduce new failures: bun installs `bunx.exe` as a hardlink of
 * `bun.exe` on Windows, so mapping `bunx` to `bunx.cmd` would MISS a healthy
 * install. curl, powershell, and node are native `.exe` and resolve as-is.
 * Add an entry here only with evidence of how that specific tool ships.
 */
const WINDOWS_CMD_SHIMS = new Set(['npm']);

export function execName(command: string, platform: NodeJS.Platform = process.platform): string {
    if (platform !== 'win32') return command;
    return WINDOWS_CMD_SHIMS.has(command) ? `${command}.cmd` : command;
}

export interface LaunchSpec {
    /** The file to hand to execFile/spawn. */
    file: string;
    /** The full argv, including any cmd.exe preamble. */
    args: string[];
}

const BATCH_EXTENSIONS = /\.(cmd|bat)$/i;

/**
 * Resolve a command + args into something the platform can actually launch.
 * On POSIX this is the identity. On win32 it maps shim names and wraps batch
 * scripts in `cmd.exe /d /s /c`:
 *   /d  skip AutoRun registry commands
 *   /s  keep the remaining arguments intact
 *   /c  run and exit
 */
export function launchSpec(
    command: string,
    args: string[] = [],
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): LaunchSpec {
    if (platform !== 'win32') return { file: command, args };
    const resolved = execName(command, platform);
    if (!BATCH_EXTENSIONS.test(resolved)) return { file: resolved, args };
    return {
        file: env['ComSpec'] || env['COMSPEC'] || 'cmd.exe',
        args: ['/d', '/s', '/c', resolved, ...args],
    };
}
