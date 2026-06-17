import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { assertExistingHomePath } from './manager/git/git-guards.js';

export type ProjectGitUnavailableReason = 'no-project' | 'not-repo' | 'git-unavailable';

export type ProjectGitSummary =
    | {
        ok: true;
        available: true;
        root: string;
        repoRoot: string;
        branch: string | null;
        head: string | null;
        trackedChangedCount: number;
        untrackedCount: number;
        dirty: boolean;
    }
    | {
        ok: true;
        available: false;
        reason: ProjectGitUnavailableReason;
    };

export type ProjectGitRunner = (cwd: string, args: string[]) => Promise<string>;

export type ProjectGitStatusCounts = {
    trackedChangedCount: number;
    untrackedCount: number;
};

export function parseProjectGitStatusPorcelain(output: string): ProjectGitStatusCounts {
    const parts = output.split('\0').filter(Boolean);
    let trackedChangedCount = 0;
    let untrackedCount = 0;

    for (let index = 0; index < parts.length; index += 1) {
        const record = parts[index] ?? '';
        if (record.length < 4) continue;
        const status = record.slice(0, 2);
        if (status === '??') {
            untrackedCount += 1;
            continue;
        }
        if (status === '!!') continue;
        trackedChangedCount += 1;
        if ((status[0] === 'R' || status[1] === 'R') && index + 1 < parts.length) {
            index += 1;
        }
    }

    return { trackedChangedCount, untrackedCount };
}

export function readPrimaryProjectRoot(projectDirs: unknown): string | null {
    if (!Array.isArray(projectDirs)) return null;
    const first = projectDirs.find((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0);
    if (!first) return null;
    return first.trim();
}

export function runProjectGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolveOutput, rejectOutput) => {
        execFile('git', args, { cwd, maxBuffer: 1024 * 1024, timeout: 5_000 }, (error, stdout, stderr) => {
            if (!error) {
                resolveOutput(stdout.trim());
                return;
            }
            rejectOutput(new Error(stderr.trim() || error.message));
        });
    });
}

export async function getProjectGitSummary(projectDirs: unknown, runner: ProjectGitRunner = runProjectGit): Promise<ProjectGitSummary> {
    const primaryRoot = readPrimaryProjectRoot(projectDirs);
    if (!primaryRoot) return { ok: true, available: false, reason: 'no-project' };

    if (!isAbsolute(primaryRoot)) return { ok: true, available: false, reason: 'git-unavailable' };

    let root: string;
    try {
        root = assertExistingHomePath(resolve(primaryRoot), 'project root');
    } catch {
        return { ok: true, available: false, reason: 'git-unavailable' };
    }

    let repoRoot: string;
    try {
        repoRoot = assertExistingHomePath(resolve(await runner(root, ['rev-parse', '--show-toplevel'])), 'repo root');
    } catch {
        return { ok: true, available: false, reason: 'not-repo' };
    }

    try {
        const [branchOutput, headOutput, statusOutput] = await Promise.all([
            runner(repoRoot, ['branch', '--show-current']).catch(() => ''),
            runner(repoRoot, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
            runner(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        ]);
        const counts = parseProjectGitStatusPorcelain(statusOutput);
        return {
            ok: true,
            available: true,
            root,
            repoRoot,
            branch: branchOutput.trim() || null,
            head: headOutput.trim() || null,
            trackedChangedCount: counts.trackedChangedCount,
            untrackedCount: counts.untrackedCount,
            dirty: counts.trackedChangedCount > 0 || counts.untrackedCount > 0,
        };
    } catch {
        return { ok: true, available: false, reason: 'git-unavailable' };
    }
}
