import { posix as pathPosix, resolve } from 'node:path';
import { isWithinHome } from './git-guards.js';
import { runGit } from './git-runner.js';

export type GitStatusMapOptions = {
    includeIgnored: boolean;
    includeUntracked: boolean;
};

export type GitStatusMapRequestOptions = Partial<GitStatusMapOptions>;

export type GitFileDecorationKind =
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'untracked'
    | 'ignored'
    | 'conflict'
    | 'submodule';

export type GitFileDecoration = {
    path: string;
    repoRelativePath: string;
    kind: GitFileDecorationKind;
    staged: boolean;
    unstaged: boolean;
    ignored: boolean;
    conflict: boolean;
    submodule: boolean;
};

export type GitDirectoryDecoration = {
    path: string;
    repoRelativePath: string;
    kinds: GitFileDecorationKind[];
    changedCount: number;
};

export type GitStatusMapResult = {
    repoRoot: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    files: GitFileDecoration[];
    directories: GitDirectoryDecoration[];
};

const KIND_PRIORITY: GitFileDecorationKind[] = ['conflict', 'deleted', 'renamed', 'added', 'modified', 'untracked', 'submodule', 'ignored'];
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readGitStatusMapOptions(raw: unknown): GitStatusMapOptions {
    const input = isRecord(raw) ? raw : {};
    return {
        includeIgnored: input['includeIgnored'] !== false,
        includeUntracked: input['includeUntracked'] !== false,
    };
}

function sortedKinds(kinds: Iterable<GitFileDecorationKind>): GitFileDecorationKind[] {
    const set = new Set(kinds);
    return KIND_PRIORITY.filter(kind => set.has(kind));
}

function isStaged(status: string): boolean {
    const x = status[0] ?? ' ';
    return x !== ' ' && x !== '?' && x !== '!';
}

function isUnstaged(status: string): boolean {
    const y = status[1] ?? ' ';
    return y !== ' ' && y !== '?' && y !== '!';
}

function statusKind(status: string): GitFileDecorationKind {
    const x = status[0] ?? ' ';
    const y = status[1] ?? ' ';
    if (CONFLICT_CODES.has(status)) return 'conflict';
    if (x === '!' && y === '!') return 'ignored';
    if (x === '?' && y === '?') return 'untracked';
    if (x === 'R' || y === 'R') return 'renamed';
    if (x === 'D' || y === 'D') return 'deleted';
    if (x === 'A' || y === 'A') return 'added';
    if (x === 'S' || y === 'S') return 'submodule';
    return 'modified';
}

function pushDirectoryAggregate(map: Map<string, Set<GitFileDecorationKind>>, repoRelativePath: string, kind: GitFileDecorationKind): void {
    let current = pathPosix.dirname(repoRelativePath);
    while (current && current !== '.') {
        const set = map.get(current) ?? new Set<GitFileDecorationKind>();
        set.add(kind);
        map.set(current, set);
        current = pathPosix.dirname(current);
    }
}

export function parseGitStatusPorcelain(repoRoot: string, output: string): Pick<GitStatusMapResult, 'files' | 'directories' | 'dirty'> {
    const parts = output.split('\0').filter(Boolean);
    const files: GitFileDecoration[] = [];
    const directoryKinds = new Map<string, Set<GitFileDecorationKind>>();
    for (let index = 0; index < parts.length; index += 1) {
        const record = parts[index] ?? '';
        if (record.length < 4) continue;
        const status = record.slice(0, 2);
        const firstPath = record.slice(3);
        if (!firstPath) continue;
        let repoRelativePath = firstPath;
        const kind = statusKind(status);
        if (kind === 'renamed' && index + 1 < parts.length) {
            repoRelativePath = parts[index + 1] ?? firstPath;
            index += 1;
        }
        const absolutePath = resolve(repoRoot, repoRelativePath);
        const decoration: GitFileDecoration = {
            path: absolutePath,
            repoRelativePath,
            kind,
            staged: isStaged(status),
            unstaged: isUnstaged(status),
            ignored: kind === 'ignored',
            conflict: kind === 'conflict',
            submodule: kind === 'submodule',
        };
        files.push(decoration);
        pushDirectoryAggregate(directoryKinds, repoRelativePath, kind);
    }
    const directories: GitDirectoryDecoration[] = Array.from(directoryKinds.entries())
        .map(([repoRelativePath, kinds]) => ({
            path: resolve(repoRoot, repoRelativePath),
            repoRelativePath,
            kinds: sortedKinds(kinds),
            changedCount: files.filter(file => file.repoRelativePath.startsWith(`${repoRelativePath}/`)).length,
        }))
        .filter(directory => directory.changedCount > 0);
    return { files, directories, dirty: files.some(file => !file.ignored) };
}

export async function getGitStatusMap(repoRoot: string, options: GitStatusMapOptions): Promise<GitStatusMapResult> {
    if (!isWithinHome(repoRoot)) throw new Error('path not allowed');
    const args = ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z'];
    args.push(options.includeIgnored ? '--ignored=matching' : '--ignored=no');
    args.push(options.includeUntracked ? '--untracked-files=all' : '--untracked-files=no');
    const output = await runGit(args, repoRoot);
    const parsed = parseGitStatusPorcelain(repoRoot, output);
    const branch = (await runGit(['branch', '--show-current'], repoRoot).catch(() => '')).trim() || null;
    const head = (await runGit(['rev-parse', '--short', 'HEAD'], repoRoot).catch(() => '')).trim() || null;
    return { repoRoot, branch, head, ...parsed };
}
