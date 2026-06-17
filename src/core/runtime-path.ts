import fs from 'node:fs';
import os from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

function uniquePaths(paths: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of paths) {
        const trimmed = String(entry || '').trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
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
): string {
    const seeded = String(seedPath || '')
        .split(delimiter)
        .map((segment) => segment.trim())
        .filter(Boolean);

    const defaults = [
        dirname(process.execPath),
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

    return uniquePaths([...seeded, ...extraDirs, ...defaults]).join(delimiter);
}
