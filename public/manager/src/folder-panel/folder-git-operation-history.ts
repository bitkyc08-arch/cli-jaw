import type { GitWorktreeOperation, GitWorktreeOperationPreview } from './folder-worktree-types';

export type FolderGitOperationHistoryStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export type FolderGitOperationHistoryItem = {
    id: string;
    operation: GitWorktreeOperation;
    startedAt: string;
    finishedAt: string | null;
    operationLabel: string;
    commandPreview: string[];
    status: FolderGitOperationHistoryStatus;
    stdout: string;
    stderr: string;
    error: string | null;
};

const FOLDER_GIT_OPERATION_HISTORY_LIMIT = 8;
let nextHistoryId = 0;

function historyId(): string {
    nextHistoryId += 1;
    return `folder-git-op-${Date.now()}-${nextHistoryId}`;
}

function blockedError(error: string): boolean {
    return /dirty|uncommitted|confirmation required|not registered|outside home|symlink/i.test(error);
}

export function createFolderGitOperationHistoryItem(
    operation: GitWorktreeOperation,
    preview: GitWorktreeOperationPreview | null,
): FolderGitOperationHistoryItem {
    return {
        id: historyId(),
        operation,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        operationLabel: preview?.label ?? operation.type,
        commandPreview: preview?.command ?? [],
        status: 'running',
        stdout: '',
        stderr: '',
        error: null,
    };
}

export function addFolderGitOperationHistoryItem(
    history: FolderGitOperationHistoryItem[],
    item: FolderGitOperationHistoryItem,
): FolderGitOperationHistoryItem[] {
    return [item, ...history].slice(0, FOLDER_GIT_OPERATION_HISTORY_LIMIT);
}

export function finishFolderGitOperationHistoryItem(
    history: FolderGitOperationHistoryItem[],
    id: string,
    result: { ok: true; stdout: string } | { ok: false; error: string },
): FolderGitOperationHistoryItem[] {
    return history.map(item => {
        if (item.id !== id) return item;
        if (result.ok) {
            return {
                ...item,
                finishedAt: new Date().toISOString(),
                status: 'succeeded',
                stdout: result.stdout,
                error: null,
            };
        }
        return {
            ...item,
            finishedAt: new Date().toISOString(),
            status: blockedError(result.error) ? 'blocked' : 'failed',
            error: result.error,
        };
    });
}
