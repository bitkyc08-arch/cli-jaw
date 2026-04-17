import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';

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

export function buildServicePath(
    seedPath = process.env.PATH || '',
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
        join(homeDir, 'bin'),
        join(homeDir, '.npm-global', 'bin'),
        join(homeDir, '.yarn', 'bin'),
        join(homeDir, '.pnpm'),
        join(homeDir, '.cargo', 'bin'),
        join(homeDir, '.bun', 'bin'),
        join(homeDir, '.volta', 'bin'),
        join(homeDir, '.asdf', 'shims'),
        join(homeDir, '.asdf', 'bin'),
        join(homeDir, '.nodenv', 'shims'),
        join(homeDir, '.nodenv', 'bin'),
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
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

function detectNpmPrefixBin(): string | null {
    try {
        const prefix = execSync('npm config get prefix', {
            encoding: 'utf8', stdio: 'pipe', timeout: 5000,
        }).trim();
        if (!prefix) return null;
        const binDir = join(prefix, 'bin');
        return fs.existsSync(binDir) ? binDir : null;
    } catch {
        return null;
    }
}

/**
 * Build the canonical PATH pin used by the native launcher (baked via
 * PINNED_PATH) and the launchd plist (EnvironmentVariables.PATH).
 *
 * Extends buildServicePath() with npm's *actual* global prefix so copilot
 * and other npm-installed CLIs are discoverable.
 */
export function buildPinnedPath(
    homeDir: string = os.homedir(),
): string {
    const extras: string[] = [];
    const npmBin = detectNpmPrefixBin();
    if (npmBin) extras.push(npmBin);
    return buildServicePath(process.env.PATH || '', extras, homeDir);
}
