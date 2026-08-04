import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildServicePath } from './runtime-path.js';
import { classifyClaudeInstall } from './claude-install.js';

export interface RejectedCliCandidate {
    path: string;
    reason: string;
}

export interface CliDetection {
    available: boolean;
    path: string | null;
    rejected?: RejectedCliCandidate[];
}

export interface CliBinaryCandidate {
    path: string;
    spawnable: boolean;
    reason?: string;
}

export interface CliCandidateScan {
    candidates: CliBinaryCandidate[];
}

function uniqueLines(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        out.push(candidate);
    }
    return out;
}

const BUN_DEPRIO_CLIS = new Set(['claude', 'codex', 'copilot', 'opencode']);

/**
 * Extensions the Windows spawn path can actually launch: a bare .exe/.com
 * directly, and .cmd/.bat through ComSpec.
 *
 * Deliberately NOT the full PATHEXT list. src/agent/spawn.ts sets
 * `shell: true` for any non-.exe path on win32, which is the documented-safe
 * route for batch files and nothing else — cmd.exe cannot run a .ps1, and a
 * custom PATHEXT entry only works if a file association happens to exist.
 */
const WINDOWS_SPAWNABLE_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD'];

/** Microsoft-documented default, used only when PATHEXT is absent. */
const WINDOWS_DEFAULT_PATHEXT = [
    '.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.VBE',
    '.JS', '.JSE', '.WSF', '.WSH', '.MSC',
];

export function windowsPathExt(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env['PATHEXT'] || env['PathExt'] || env['pathext'];
    if (!raw) return [...WINDOWS_DEFAULT_PATHEXT];
    return raw.split(';').map((ext) => ext.trim().toUpperCase()).filter(Boolean);
}

function hasExtension(candidate: string, extensions: readonly string[]): boolean {
    const upper = candidate.toUpperCase();
    return extensions.some((ext) => upper.endsWith(ext));
}

function windowsExtensionRank(candidate: string, env: NodeJS.ProcessEnv = process.env): number {
    const upper = candidate.toUpperCase();
    // A native .exe beats a shim; a .cmd shim beats the extensionless POSIX
    // shim, which cmd.exe cannot run at all. npm writes all three on Windows.
    if (upper.endsWith('.EXE') || upper.endsWith('.COM')) return 0;
    if (upper.endsWith('.CMD') || upper.endsWith('.BAT')) return 1;
    if (upper.endsWith('.PS1')) return 2;
    // Other PATHEXT entries rank below the launchable set but above unknowns.
    return hasExtension(candidate, windowsPathExt(env)) ? 3 : 4;
}

function normalizedPath(filePath: string): string {
    return path.normalize(filePath);
}

function isPathInside(candidate: string, dir: string): boolean {
    const relative = path.relative(dir, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isBunBinCandidate(candidate: string, homeDir = os.homedir()): boolean {
    const normalized = normalizedPath(candidate);
    return isPathInside(normalized, path.join(homeDir, '.bun', 'bin'));
}

function isClaudeNativeCandidate(candidate: string, homeDir = os.homedir()): boolean {
    const normalized = normalizedPath(candidate);
    const nativeBins = [
        path.join(homeDir, '.local', 'bin', 'claude'),
        path.join(homeDir, '.local', 'bin', 'claude.exe'),
        path.join(homeDir, '.claude', 'local', 'bin', 'claude'),
        path.join(homeDir, '.claude', 'local', 'bin', 'claude.exe'),
    ].map(normalizedPath);
    if (nativeBins.includes(normalized)) return true;

    try {
        const realPath = fs.realpathSync(candidate);
        return classifyClaudeInstall(realPath) === 'native';
    } catch {
        return classifyClaudeInstall(normalized) === 'native';
    }
}

function isManagedNodeCandidate(candidate: string, homeDir = os.homedir()): boolean {
    const normalized = normalizedPath(candidate);
    const candidateDir = path.dirname(normalized);
    const preferredDirs = [
        path.dirname(process.execPath),
        path.join(homeDir, '.local', 'bin'),
        path.join(homeDir, '.claude', 'local', 'bin'),
        path.join(homeDir, 'bin'),
        path.join(homeDir, '.npm-global', 'bin'),
        path.join(homeDir, '.yarn', 'bin'),
        path.join(homeDir, '.pnpm'),
        path.join(homeDir, '.volta', 'bin'),
    ];
    if (preferredDirs.some((dir) => candidateDir === path.normalize(dir))) return true;

    const managedRoots = [
        path.join(homeDir, '.nvm', 'versions', 'node'),
        path.join(homeDir, '.local', 'share', 'fnm', 'node-versions'),
        path.join(homeDir, '.fnm', 'node-versions'),
    ];
    return managedRoots.some((root) => isPathInside(normalized, path.normalize(root)));
}

/**
 * Installer-provenance bucket, independent of PATH position: 0 preferred,
 * higher is more suspect. Kept separate from `candidatePriority` so Windows
 * can combine it with extension rank instead of with the PATH index.
 */
function candidateProvenanceBucket(cliName: string, candidate: string, homeDir = os.homedir()): number {
    if (!BUN_DEPRIO_CLIS.has(cliName)) return 0;
    if (cliName === 'claude' && isClaudeNativeCandidate(candidate, homeDir)) return 0;
    if (isManagedNodeCandidate(candidate, homeDir)) return 1;
    if (isBunBinCandidate(candidate, homeDir)) return 3;
    return 2;
}

function candidatePriority(cliName: string, candidate: string, index: number, homeDir = os.homedir()): number {
    if (!BUN_DEPRIO_CLIS.has(cliName)) return index;
    if (cliName === 'claude' && isClaudeNativeCandidate(candidate, homeDir)) return index;
    if (isManagedNodeCandidate(candidate, homeDir)) return 1_000 + index;
    if (isBunBinCandidate(candidate, homeDir)) return 10_000 + index;
    return 5_000 + index;
}

export function prioritizeCliCandidates(
    cliName: string,
    candidates: string[],
    homeDir = os.homedir(),
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    if (platform === 'win32') {
        // Provenance stays the PRIMARY key and extension is only a tiebreak
        // within a bucket. Bun installs to %USERPROFILE%\.bun\bin on Windows
        // too, so ranking by extension alone would let a stale bun shim shadow
        // a working npm/native install — worse than on POSIX, because a bun
        // .exe would outrank every npm .cmd.
        return candidates
            .map((candidate, index) => ({
                candidate,
                index,
                provenance: candidateProvenanceBucket(cliName, candidate, homeDir),
                extension: windowsExtensionRank(candidate, env),
            }))
            .sort((a, b) => (a.provenance - b.provenance)
                || (a.extension - b.extension)
                || (a.index - b.index))
            .map((entry) => entry.candidate);
    }
    if (!BUN_DEPRIO_CLIS.has(cliName)) return candidates;
    return candidates
        .map((candidate, index) => ({ candidate, priority: candidatePriority(cliName, candidate, index, homeDir) }))
        .sort((a, b) => a.priority - b.priority)
        .map((entry) => entry.candidate);
}

function readHead(filePath: string, length = 64): Buffer {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        fs.closeSync(fd);
    }
}

function hasKnownExecutableMagic(head: Buffer, platform: NodeJS.Platform = process.platform): boolean {
    if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true; // ELF
    if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return platform === 'win32'; // PE/MZ: Windows only
    if (head.length < 4) return false;
    const magic = head.subarray(0, 4).toString('hex');
    return [
        'feedface',
        'cefaedfe',
        'feedfacf',
        'cffaedfe',
        'cafebabe',
        'bebafeca',
    ].includes(magic);
}

export function isSpawnableCliFile(filePath: string, platform: NodeJS.Platform = process.platform): { ok: boolean; reason?: string } {
    if (platform === 'win32') {
        try {
            if (!fs.statSync(filePath).isFile()) return { ok: false, reason: 'not a regular file' };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return { ok: false, reason: code || 'not found' };
        }
        const upper = filePath.toUpperCase();
        // .exe/.com are spawned DIRECTLY (spawn.ts only takes the ComSpec
        // route for non-.exe), so a corrupt or text file named .exe fails at
        // launch with no fallback. Validate the PE/MZ header rather than
        // trusting the extension, otherwise a broken .exe on PATH shadows a
        // perfectly good .cmd shim that ranks behind it.
        if (upper.endsWith('.EXE') || upper.endsWith('.COM')) {
            let head: Buffer;
            try {
                head = readHead(filePath, 2);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                return { ok: false, reason: code || 'unreadable' };
            }
            if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return { ok: true };
            return { ok: false, reason: 'not a windows executable (missing MZ header)' };
        }
        // .cmd/.bat run through ComSpec, which parses them as text: there is
        // no header to validate.
        if (hasExtension(filePath, WINDOWS_SPAWNABLE_EXTENSIONS)) return { ok: true };
        if (filePath.toUpperCase().endsWith('.PS1')) {
            return { ok: false, reason: 'powershell shim is not spawnable via ComSpec' };
        }
        return { ok: false, reason: 'no windows-executable extension' };
    }

    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
        if ((stat.mode & 0o111) === 0) return { ok: false, reason: 'not executable' };
        const head = readHead(filePath);
        if (head.length === 0) return { ok: false, reason: 'empty file' };
        if (head[0] === 0x23 && head[1] === 0x21) return { ok: true }; // #!
        if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
            return { ok: false, reason: 'windows executable on non-windows platform' };
        }
        if (hasKnownExecutableMagic(head, platform)) return { ok: true };
        if (head.includes(0)) return { ok: true };
        return { ok: false, reason: 'text file without shebang' };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { ok: false, reason: code || (error as Error).message };
    }
}

export function selectSpawnableCliPath(
    candidates: string[],
    platform: NodeJS.Platform = process.platform,
): CliDetection {
    const rejected: RejectedCliCandidate[] = [];
    for (const candidate of candidates) {
        const check = isSpawnableCliFile(candidate, platform);
        if (check.ok) {
            return {
                available: true,
                path: candidate,
                ...(rejected.length ? { rejected } : {}),
            };
        }
        rejected.push({ path: candidate, reason: check.reason || 'not spawnable' });
    }
    return {
        available: false,
        path: null,
        ...(rejected.length ? { rejected } : {}),
    };
}

export function readProcessPath(env: NodeJS.ProcessEnv = process.env): string {
    return env["PATH"] || env["Path"] || env["path"] || '';
}

export function buildCliDetectionEnv(
    seedPath: string,
    env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const next: NodeJS.ProcessEnv = { ...env };
    delete next["PATH"];
    delete next["Path"];
    delete next["path"];
    next[process.platform === 'win32' ? 'Path' : 'PATH'] = buildServicePath(seedPath);
    return next;
}

export function listCliBinaryCandidates(name: string, seedPath = readProcessPath()): CliCandidateScan {
    if (!/^[a-z0-9_-]+$/i.test(name)) return { candidates: [] };
    try {
        // `where.exe` rather than bare `where`: names the real executable and
        // does not depend on PATHEXT resolving the launcher's own name.
        const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
        const args = process.platform === 'win32' ? [name] : ['-a', name];
        const raw = execFileSync(cmd, args, {
            encoding: 'utf8',
            timeout: 3000,
            env: buildCliDetectionEnv(seedPath),
        }).trim();
        const paths = prioritizeCliCandidates(name, uniqueLines(raw));
        return {
            candidates: paths.map((candidatePath) => {
                const check = isSpawnableCliFile(candidatePath);
                const candidate: CliBinaryCandidate = {
                    path: candidatePath,
                    spawnable: check.ok,
                };
                if (!check.ok && check.reason) candidate.reason = check.reason;
                return candidate;
            }),
        };
    } catch {
        return { candidates: [] };
    }
}

export function detectCliBinary(name: string, seedPath = readProcessPath()): CliDetection {
    const scan = listCliBinaryCandidates(name, seedPath);
    return selectSpawnableCliPath(scan.candidates.map((candidate) => candidate.path));
}
