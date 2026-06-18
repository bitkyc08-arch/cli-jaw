import { useEffect, useState } from 'react';
import type { FolderPanelRowDecoration } from './folder-panel-types';
import { loadFolderGitStatus } from './folder-git-client';
import {
    EMPTY_FOLDER_GIT_STATE,
    type FolderPanelGitState,
    type GitDirectoryDecoration,
    type GitFileDecoration,
    type GitFileDecorationKind,
    type GitStatusMapResult,
} from './folder-git-types';

type UseFolderGitStatusInput = {
    rootPath: string | null;
    repoRoot?: string | null;
    enabled: boolean;
    refreshToken: number;
};

const KIND_LABEL: Record<GitFileDecorationKind, string> = {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    untracked: '?',
    ignored: '·',
    conflict: 'U',
    submodule: 'S',
};

function decorationForFile(file: GitFileDecoration): FolderPanelRowDecoration {
    return {
        className: `git-${file.kind}`,
        label: KIND_LABEL[file.kind],
        title: [
            file.kind,
            file.staged ? 'staged' : '',
            file.unstaged ? 'unstaged' : '',
        ].filter(Boolean).join(' · '),
    };
}

function decorationForDirectory(directory: GitDirectoryDecoration): FolderPanelRowDecoration {
    const kind = directory.kinds[0] ?? 'modified';
    return {
        className: `git-${kind}`,
        label: `${KIND_LABEL[kind]}${directory.changedCount > 1 ? directory.changedCount : ''}`,
        title: `${directory.changedCount} changed item${directory.changedCount === 1 ? '' : 's'}`,
    };
}

function stateFromStatus(status: GitStatusMapResult): FolderPanelGitState {
    const decorationsByPath = new Map<string, FolderPanelRowDecoration>();
    for (const file of status.files) decorationsByPath.set(file.path, decorationForFile(file));
    for (const directory of status.directories) decorationsByPath.set(directory.path, decorationForDirectory(directory));
    return {
        available: true,
        loading: false,
        error: null,
        repoRoot: status.repoRoot,
        branch: status.branch,
        head: status.head,
        dirty: status.dirty,
        decorationsByPath,
    };
}

export function useFolderGitStatus(input: UseFolderGitStatusInput): FolderPanelGitState {
    const { rootPath, repoRoot, enabled, refreshToken } = input;
    const [state, setState] = useState<FolderPanelGitState>(EMPTY_FOLDER_GIT_STATE);

    useEffect(() => {
        if (!enabled || rootPath === null) {
            setState(EMPTY_FOLDER_GIT_STATE);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            setState(prev => ({ ...prev, loading: true, error: null }));
            void (async () => {
                const result = await loadFolderGitStatus(rootPath, {
                    ...(repoRoot ? { repoRoot } : {}),
                    includeIgnored: true,
                    includeUntracked: true,
                });
                if (cancelled) return;
                if (result.ok) {
                    setState(stateFromStatus(result.status));
                    return;
                }
                setState(result.quiet
                    ? EMPTY_FOLDER_GIT_STATE
                    : { ...EMPTY_FOLDER_GIT_STATE, error: result.error });
            })();
        }, 250);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [enabled, refreshToken, repoRoot, rootPath]);

    return state;
}
