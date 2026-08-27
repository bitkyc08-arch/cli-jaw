import fs from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve, win32 as pathWin32 } from 'node:path';

function uniquePaths(paths: Array<string | null | undefined>, caseInsensitive = false): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of paths) {
        const trimmed = String(entry || '').trim();
        if (!trimmed) continue;
        const key = caseInsensitive ? trimmed.toLowerCase() : trimmed;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
}

/**
 * Split a PATH string using the delimiter its producer actually used.
 *
 * A win32 process can inherit a POSIX-delimited PATH from MSYS/git-bash.
 * Splitting that on ';' yields one giant entry that resolves nothing (#273).
 *
 * Colon splitting has one ambiguity: 'C:\x' contains a delimiter-looking
 * colon. Splitting on ':' turns it into ['C', '\x'], so any single-letter
 * fragment followed by a non-empty fragment is rejoined. The rejoin does NOT
 * require a leading separator: 'C:tools' and 'C:.\node_modules\.bin' are
 * drive-RELATIVE and equally valid Windows PATH entries.
 * A whole-string "every part starts with /" test is NOT enough: a real
 * git-bash PATH mixes POSIX entries with inherited Windows ones, e.g.
 * '/mingw64/bin:/usr/bin:C:\\Users\\u\\AppData\\Roaming\\npm'.
 */
export function splitPathList(raw: string, platform: NodeJS.Platform = process.platform): string[] {
    const value = String(raw || '').trim();
    if (!value) return [];
    if (platform !== 'win32') return value.split(':').map(s => s.trim()).filter(Boolean);

    // A semicolon is unambiguous on Windows: the producer used the native
    // delimiter, so no colon interpretation is needed.
    if (value.includes(';')) return value.split(';').map(s => s.trim()).filter(Boolean);
    if (!value.includes(':')) return [value];

    const raws = value.split(':');
    const out: string[] = [];
    for (let i = 0; i < raws.length; i++) {
        const part = (raws[i] ?? '').trim();
        if (!part) continue;
        const next = raws[i + 1];
        // Rejoin any drive-qualified entry, absolute ('C:\tools') or
        // drive-relative ('C:tools', 'C:.\node_modules\.bin'). Windows accepts
        // both, and path.win32.resolve treats the latter as a real path, so a
        // rejoin rule that only accepted a following separator would split one
        // valid entry into two invalid ones.
        if (/^[A-Za-z]$/.test(part) && next !== undefined && next !== '') {
            out.push(`${part}:${next.trim()}`);
            i++;
            continue;
        }
        out.push(part);
    }
    return out.filter(Boolean);
}

/**
 * Windows system directories a spawned process cannot work without.
 *
 * Omitting System32 is what #294 reported: without it the agent cannot
 * resolve powershell, where, or cmd, and silently works around the gap.
 */

/**
 * Convert an MSYS/git-bash PATH entry to a form win32 tools can resolve.
 *
 * #273 fixed the DELIMITER — a POSIX-delimited PATH inherited from git-bash
 * was split on ';' and collapsed into one useless entry. It did not touch the
 * entry FORMAT, so '/c/Users/u/AppData/Roaming/npm' still reached `where.exe`
 * verbatim, and `where.exe` is a native Win32 tool that cannot read it. A
 * server started from git-bash therefore resolves nothing while a natively
 * started one on the same host resolves fine (#471).
 *
 * Two shapes convert; a third deliberately does not:
 *   '/c/x'        → 'C:\x'   (MSYS drive mapping)
 *   '/cygdrive/c/x' → 'C:\x' (Cygwin's default prefix)
 *   '/usr/bin'    → dropped   MSYS-internal, with no Win32 equivalent. Keeping
 *                             it would leave an unresolvable entry on PATH;
 *                             the caller re-seeds the real system dirs anyway.
 */
export function normalizeWindowsPathEntry(entry: string): string | null {
    const value = entry.trim();
    if (!value) return null;
    // Already a Windows entry (drive-qualified or UNC): leave it alone.
    if (/^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) return value;
    if (!value.startsWith('/')) return value;

    const cygwin = /^\/cygdrive\/([A-Za-z])(\/.*)?$/.exec(value);
    const msys = /^\/([A-Za-z])(\/.*)?$/.exec(value);
    const match = cygwin ?? msys;
    if (match) {
        const drive = (match[1] as string).toUpperCase();
        const rest = (match[2] ?? '').replace(/\//g, '\\');
        return `${drive}:${rest || '\\'}`;
    }
    // A POSIX path with no drive mapping ('/usr/bin', '/mingw64/bin').
    return null;
}

function windowsSystemDirs(env: NodeJS.ProcessEnv): string[] {
    const systemRoot = env['SystemRoot'] || env['windir'] || 'C:\\WINDOWS';
    const system32 = pathWin32.join(systemRoot, 'System32');
    return [
        system32,
        systemRoot,
        pathWin32.join(system32, 'Wbem'),
        pathWin32.join(system32, 'WindowsPowerShell', 'v1.0'),
    ];
}

function windowsUserDirs(env: NodeJS.ProcessEnv, homeDir: string): string[] {
    const appData = env['APPDATA'] || pathWin32.join(homeDir, 'AppData', 'Roaming');
    const localAppData = env['LOCALAPPDATA'] || pathWin32.join(homeDir, 'AppData', 'Local');
    return [
        pathWin32.join(appData, 'npm'),
        pathWin32.join(localAppData, 'Microsoft', 'WindowsApps'),
        pathWin32.join(homeDir, '.local', 'bin'),
        pathWin32.join(homeDir, '.cargo', 'bin'),
        pathWin32.join(homeDir, '.bun', 'bin'),
    ];
}

function listManagedNodeBins(homeDir: string): string[] {
    const out: string[] = [];
    for (const root of [
        join(homeDir, '.nvm', 'versions', 'node'),
        join(homeDir, '.local', 'share', 'fnm', 'node-versions'),
        join(homeDir, '.fnm', 'node-versions'),
    ]) {
        try {
            const versions = fs.readdirSync(root, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(root, entry.name, 'bin'))
                .filter((binDir) => fs.existsSync(binDir))
                .sort()
                .reverse();
            out.push(...versions);
        } catch { /* optional runtime managers may be absent */ }
    }
    return out;
}

function nodeBinaryName(platform = process.platform): string {
    return platform === 'win32' ? 'node.exe' : 'node';
}

export function resolveBundledNodePath(
    anchorPath = process.argv[1] || '',
    platform = process.platform,
): string | null {
    if (!anchorPath) return null;

    let dir = dirname(resolve(anchorPath));
    while (true) {
        if (basename(dir) === 'dist') {
            const candidate = join(dirname(dir), nodeBinaryName(platform));
            if (fs.existsSync(candidate)) return candidate;
        }

        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export function buildServicePath(
    seedPath = process.env["PATH"] || '',
    extraDirs: string[] = [],
    homeDir = os.homedir(),
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const isWindows = platform === 'win32';
    // Normalize BEFORE deduping: '/c/x' and 'C:\x' are the same directory
    // spelled two ways, and only one of them is resolvable.
    const seeded = isWindows
        ? splitPathList(seedPath, platform)
            .map(normalizeWindowsPathEntry)
            .filter((entry): entry is string => entry !== null)
        : splitPathList(seedPath, platform);

    // On win32 this must be normalized too: under git-bash `process.execPath`
    // can itself be POSIX-spelled, and it is prepended ahead of every seeded
    // entry — so an unnormalized one puts an unresolvable path FIRST (#471).
    const common = [dirname(process.execPath)];
    const unixDefaults = [
        join(homeDir, '.local', 'bin'),
        join(homeDir, '.claude', 'local', 'bin'),
        join(homeDir, 'bin'),
        join(homeDir, '.npm-global', 'bin'),
        join(homeDir, '.yarn', 'bin'),
        join(homeDir, '.pnpm'),
        join(homeDir, '.cargo', 'bin'),
        join(homeDir, '.bun', 'bin'),
        join(homeDir, '.volta', 'bin'),
        join(homeDir, '.deno', 'bin'),
        join(homeDir, '.asdf', 'shims'),
        join(homeDir, '.asdf', 'bin'),
        join(homeDir, '.nodenv', 'shims'),
        join(homeDir, '.nodenv', 'bin'),
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/opt/homebrew/opt/node@22/bin',
        '/usr/local/bin',
        '/usr/local/sbin',
        '/home/linuxbrew/.linuxbrew/bin',
        '/home/linuxbrew/.linuxbrew/sbin',
        '/usr/bin',
        '/usr/sbin',
        '/bin',
        '/sbin',
        ...listManagedNodeBins(homeDir),
    ];
    const defaults = isWindows
        ? [...common, ...windowsSystemDirs(env), ...windowsUserDirs(env, homeDir)]
            .map(normalizeWindowsPathEntry)
            .filter((entry): entry is string => entry !== null)
        : [...common, ...unixDefaults];

    const listDelimiter = isWindows ? ';' : ':';
    return uniquePaths([...seeded, ...extraDirs, ...defaults], isWindows).join(listDelimiter);
}
