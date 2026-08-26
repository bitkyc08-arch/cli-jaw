/**
 * Non-interactive shell PATH reachability (#479).
 *
 * `ssh host 'jaw serve ...'` runs a non-login, non-interactive shell. That
 * shell reads none of the files the installer writes to: bash skips
 * `.bash_profile`/`.profile` (login-only) and Debian's stock `.bashrc`
 * returns at its first line when non-interactive; zsh reads only `.zshenv`,
 * which the installer never touches. So a host where `jaw` works
 * interactively can still fail to resolve it over SSH, and the failure
 * surfaces as `nohup: failed to run command 'jaw'` — no PATH in sight.
 *
 * doctor cannot observe this by inspecting its own environment: it runs in
 * the shell that already works. The reachability question has to be asked
 * against the PATH a non-interactive shell would actually get, which is what
 * `getconf PATH` reports.
 */
import { delimiter, join } from 'node:path';

export interface NonInteractivePathProbes {
    /** The PATH a non-interactive shell starts from, or null when unavailable. */
    baselinePath(): string | null;
    /** True when the path names an executable file. */
    isExecutableFile(path: string): boolean;
}

export type NonInteractivePathStatus =
    /** Resolvable from the baseline PATH — remote one-shot commands work. */
    | 'reachable'
    /** Not on the baseline PATH, but found in a known install dir. */
    | 'unreachable'
    /** Not found anywhere; a PATH fix would not help. */
    | 'not-installed'
    /** No baseline PATH to test against (non-POSIX host). */
    | 'unknown';

export interface NonInteractivePathResult {
    status: NonInteractivePathStatus;
    /** The directory holding the binary, when one was found. */
    foundIn: string | null;
    /** The baseline PATH the check ran against. */
    baseline: string | null;
}

/**
 * Install directories to search after the baseline PATH misses.
 *
 * `~/.local/bin` is what `scripts/install.sh` configures and what #479
 * reported. The static list alone is not enough: a Node installed by nvm,
 * fnm, or Homebrew puts global bins under a version-specific prefix that no
 * fixed list can enumerate, and treating those as "not installed" would
 * silently drop exactly the hosts this check exists for. So the caller's own
 * resolved directories (npm prefix, the running binary's dir) are searched
 * first — they are facts about this install, not guesses.
 */
export function candidateInstallDirs(homeDir: string, knownBinDirs: string[] = []): string[] {
    return [
        ...knownBinDirs.filter(Boolean),
        join(homeDir, '.local', 'bin'),
        join(homeDir, '.npm-global', 'bin'),
        join(homeDir, 'bin'),
        join(homeDir, '.volta', 'bin'),
        join(homeDir, '.bun', 'bin'),
    ];
}

function findIn(dirs: string[], binary: string, probes: NonInteractivePathProbes): string | null {
    for (const dir of dirs) {
        if (!dir) continue;
        if (probes.isExecutableFile(join(dir, binary))) return dir;
    }
    return null;
}

/**
 * Decide whether `binary` resolves in a non-interactive shell.
 *
 * Pure over its probes so the whole matrix is testable without an SSH host.
 */
export function checkNonInteractivePath(
    binary: string,
    homeDir: string,
    probes: NonInteractivePathProbes,
    knownBinDirs: string[] = [],
): NonInteractivePathResult {
    const baseline = probes.baselinePath();
    if (!baseline) return { status: 'unknown', foundIn: null, baseline: null };

    const baselineDirs = baseline.split(delimiter).map(s => s.trim()).filter(Boolean);
    const onBaseline = findIn(baselineDirs, binary, probes);
    if (onBaseline) return { status: 'reachable', foundIn: onBaseline, baseline };

    // Only search install dirs the baseline did not already cover, so a hit
    // here always means "installed but unreachable" rather than a re-report.
    const extraDirs = candidateInstallDirs(homeDir, knownBinDirs).filter(dir => !baselineDirs.includes(dir));
    const installed = findIn(extraDirs, binary, probes);
    if (installed) return { status: 'unreachable', foundIn: installed, baseline };

    return { status: 'not-installed', foundIn: null, baseline };
}

/**
 * Operator-facing remedy for an unreachable binary.
 *
 * `~/.zshenv` is named for zsh because it is the only startup file a
 * non-interactive zsh reads; bash has no equivalent (`BASH_ENV` is honored
 * only for non-interactive shells and is not set by default), so bash users
 * get the absolute-path form, which always works.
 */
export function nonInteractivePathRemedy(binary: string, foundIn: string): string[] {
    const absolute = join(foundIn, binary);
    return [
        `call it by absolute path: ${absolute}`,
        `or export PATH in the remote command: ssh host 'export PATH="${foundIn}:$PATH"; ${binary} ...'`,
        `or (zsh) add to ~/.zshenv: export PATH="${foundIn}:$PATH"`,
    ];
}
