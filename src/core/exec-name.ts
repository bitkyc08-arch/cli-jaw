/**
 * Windows executable-name resolution for child-process spawns.
 *
 * Windows resolves a bare name on PATH only when it carries a launchable
 * extension, and npm ships as `npm.cmd` there. `execFileSync('npm', ...)`
 * therefore fails with a bare ENOENT on a machine where npm is installed and
 * working — issue #274, confirmed on the reporting host:
 *
 *     spawnSync('npm', ['--version'])                 -> ENOENT
 *     spawnSync('npm', ['--version'], {shell:true})   -> 11.17.0
 *
 * Naming the concrete file is preferred over `shell: true`: it avoids the
 * argument-escaping hazard Node warns about (DEP0190), and it matches the
 * convention already proven in `bin/commands/provider.ts` and
 * `bin/commands/jwc.ts`.
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
