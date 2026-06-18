import { getGitStatusMap, type GitFileDecoration, type GitFileDecorationKind } from './status-service.js';

export type SourceControlGroupId = 'conflicts' | 'staged' | 'changes' | 'untracked';

export type SourceControlSnapshotOptions = {
    includeUntracked: boolean;
};

export type SourceControlFile = {
    path: string;
    repoRelativePath: string;
    kind: GitFileDecorationKind;
    staged: boolean;
    unstaged: boolean;
    conflict: boolean;
};

export type SourceControlGroup = {
    id: SourceControlGroupId;
    label: string;
    files: SourceControlFile[];
};

export type SourceControlSnapshot = {
    repoRoot: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    groups: SourceControlGroup[];
};

export function readSourceControlSnapshotOptions(raw: unknown): SourceControlSnapshotOptions {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return {
        includeUntracked: input['includeUntracked'] !== false,
    };
}

function toSourceControlFile(file: GitFileDecoration): SourceControlFile {
    return {
        path: file.path,
        repoRelativePath: file.repoRelativePath,
        kind: file.kind,
        staged: file.staged,
        unstaged: file.unstaged,
        conflict: file.conflict,
    };
}

export function buildSourceControlGroups(files: GitFileDecoration[]): SourceControlGroup[] {
    const conflicts: SourceControlFile[] = [];
    const staged: SourceControlFile[] = [];
    const changes: SourceControlFile[] = [];
    const untracked: SourceControlFile[] = [];

    for (const file of files) {
        if (file.ignored || file.submodule) continue;
        const entry = toSourceControlFile(file);
        if (file.conflict) {
            conflicts.push(entry);
            continue;
        }
        if (file.kind === 'untracked') {
            untracked.push(entry);
            continue;
        }
        if (file.staged) staged.push(entry);
        if (file.unstaged) changes.push(entry);
    }

    return [
        { id: 'conflicts', label: 'Merge Changes', files: conflicts },
        { id: 'staged', label: 'Staged Changes', files: staged },
        { id: 'changes', label: 'Changes', files: changes },
        { id: 'untracked', label: 'Untracked Changes', files: untracked },
    ];
}

export async function getSourceControlSnapshot(repoRoot: string, options: SourceControlSnapshotOptions): Promise<SourceControlSnapshot> {
    const status = await getGitStatusMap(repoRoot, {
        includeIgnored: false,
        includeUntracked: options.includeUntracked,
    });
    return {
        repoRoot: status.repoRoot,
        branch: status.branch,
        head: status.head,
        dirty: status.dirty,
        groups: buildSourceControlGroups(status.files),
    };
}
