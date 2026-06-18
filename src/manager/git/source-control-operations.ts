import { posix as pathPosix } from 'node:path';
import { assertContainedLexical, isWithinHome } from './git-guards.js';
import { runGit } from './git-runner.js';
import { getSourceControlSnapshot, type SourceControlSnapshot } from './source-control-service.js';

export type SourceControlOperationKind = 'stage' | 'unstage';

export type SourceControlOperation = {
    kind: SourceControlOperationKind;
    paths: string[];
};

export type SourceControlOperationResult = {
    operation: SourceControlOperationKind;
    paths: string[];
    snapshot: SourceControlSnapshot;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRelativePath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('/')) return null;
    const normalized = pathPosix.normalize(trimmed);
    if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
    return normalized;
}

export function readSourceControlOperation(raw: unknown): SourceControlOperation {
    const input = isRecord(raw) ? raw : {};
    const kind = input['kind'] === 'unstage' ? 'unstage' : input['kind'] === 'stage' ? 'stage' : null;
    if (!kind) throw new Error('unsupported source control operation');
    const rawPaths = Array.isArray(input['paths']) ? input['paths'] : [];
    const paths = Array.from(new Set(rawPaths.map(readRelativePath).filter((path): path is string => path !== null)));
    if (paths.length === 0) throw new Error('at least one relative path is required');
    if (paths.length > 100) throw new Error('too many paths');
    return { kind, paths };
}

export async function runSourceControlOperation(repoRoot: string, operation: SourceControlOperation): Promise<SourceControlOperationResult> {
    if (!isWithinHome(repoRoot)) throw new Error('path not allowed');
    for (const path of operation.paths) {
        if (!assertContainedLexical(repoRoot, path)) throw new Error('path traversal');
    }
    const args = operation.kind === 'stage'
        ? ['add', '--', ...operation.paths]
        : ['restore', '--staged', '--', ...operation.paths];
    await runGit(args, repoRoot);
    return {
        operation: operation.kind,
        paths: operation.paths,
        snapshot: await getSourceControlSnapshot(repoRoot, { includeUntracked: true }),
    };
}
