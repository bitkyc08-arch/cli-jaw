import { useCallback, useState } from 'react';
import { copyText } from '../clipboard/copy-text';
import type { FolderPanelSource } from './folder-panel-types';
import {
    addFolderGitOperationHistoryItem,
    createFolderGitOperationHistoryItem,
    finishFolderGitOperationHistoryItem,
    type FolderGitOperationHistoryItem,
} from './folder-git-operation-history';
import { runWorktreeOperation as runWorktreeOperationClient } from './folder-worktree-ops-client';
import type { GitWorktreeOperation, GitWorktreeOperationPreview } from './folder-worktree-types';
import type { FolderWorktreeState } from './use-git-worktrees';
import type { FolderRefreshReason } from './use-folder-visible-refresh';

type OpenFolderRoot = (
    nextRoot: string,
    options: { registerGitWorktree?: boolean; repoRoot?: string | null },
) => Promise<void>;

type UseFolderWorktreeOperationsInput = {
    rootPath: string | null;
    source: FolderPanelSource;
    worktreeState: FolderWorktreeState;
    openFolderRoot: OpenFolderRoot;
    refreshVisibleTree: (reason: FolderRefreshReason) => Promise<void>;
    bumpGitRefresh: () => void;
    setActionStatus: (status: string | null) => void;
    setError: (error: string | null) => void;
};

export function useFolderWorktreeOperations(input: UseFolderWorktreeOperationsInput) {
    const {
        rootPath,
        source,
        worktreeState,
        openFolderRoot,
        refreshVisibleTree,
        bumpGitRefresh,
        setActionStatus,
        setError,
    } = input;
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [history, setHistory] = useState<FolderGitOperationHistoryItem[]>([]);

    const openWorktreeRoot = useCallback(async (path: string) => {
        await openFolderRoot(path, { registerGitWorktree: true, repoRoot: worktreeState.repoRoot });
    }, [openFolderRoot, worktreeState.repoRoot]);

    const copyWorktreePath = useCallback(async (path: string) => {
        const result = await copyText(path);
        if (result.ok) {
            setActionStatus('Copied worktree path');
            setError(null);
        } else {
            setError(result.error ?? 'Failed to copy worktree path');
        }
    }, [setActionStatus, setError]);

    const revealWorktreePath = useCallback(async (path: string) => {
        if (!rootPath || !source.registerGitWorktreeRoot || !source.revealPath) return;
        try {
            await source.registerGitWorktreeRoot(rootPath, worktreeState.repoRoot ?? undefined, path);
            await source.revealPath(path);
            setActionStatus('Opened worktree in Finder');
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [rootPath, setActionStatus, setError, source, worktreeState.repoRoot]);

    const runWorktreeOperation = useCallback(async (
        operation: GitWorktreeOperation,
        preview: GitWorktreeOperationPreview | null,
    ) => {
        if (!rootPath) return;
        const historyItem = createFolderGitOperationHistoryItem(operation, preview);
        let historyFinalized = false;
        setHistory(items => addFolderGitOperationHistoryItem(items, historyItem));
        setBusy(true);
        try {
            const result = await runWorktreeOperationClient({
                folderPanelRoot: rootPath,
                repoRoot: worktreeState.repoRoot,
                operation,
                confirmed: true,
            });
            if (!result.ok) {
                const message = result.error ?? 'Git operation failed';
                setHistory(items => finishFolderGitOperationHistoryItem(items, historyItem.id, { ok: false, error: message }));
                historyFinalized = true;
                throw new Error(message);
            }
            setHistory(items => finishFolderGitOperationHistoryItem(items, historyItem.id, { ok: true, stdout: result.stdout }));
            historyFinalized = true;
            setActionStatus(result.preview?.label ?? 'Git worktree operation completed');
            setError(null);
            setOpen(false);
            worktreeState.refresh();
            bumpGitRefresh();
            await refreshVisibleTree('git-operation');
        } catch (err) {
            const message = (err as Error).message;
            if (!historyFinalized) {
                setHistory(items => finishFolderGitOperationHistoryItem(items, historyItem.id, { ok: false, error: message }));
            }
            setError(message);
        } finally {
            setBusy(false);
        }
    }, [bumpGitRefresh, refreshVisibleTree, rootPath, setActionStatus, setError, worktreeState]);

    return {
        open,
        setOpen,
        busy,
        history,
        openWorktreeRoot,
        copyWorktreePath,
        revealWorktreePath,
        runWorktreeOperation,
    };
}
