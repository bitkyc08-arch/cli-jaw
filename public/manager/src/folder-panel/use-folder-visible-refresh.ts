import { useCallback, useEffect, useRef, useState } from 'react';
import type { FolderPanelSource } from './folder-panel-types';

export type FolderRefreshReason =
    | 'manual'
    | 'watch'
    | 'move'
    | 'mutation'
    | 'root'
    | 'git-operation'
    | 'worktree-switch';

export type FolderVisibleRefreshOptions = {
    extraPaths?: string[];
};

type RefreshResult = { ok: true } | { ok: false; error: string };

type UseFolderVisibleRefreshInput = {
    rootPath: string | null;
    expanded: Set<string>;
    source: FolderPanelSource;
    loadDir: (dirPath: string) => Promise<RefreshResult>;
    loadChildren: (dirPath: string, options: { force?: boolean }) => Promise<void>;
    bumpGitRefresh: () => void;
    onGitRefresh?: (() => void) | undefined;
    refreshWorktrees: () => void;
};

const WATCH_REFRESH_DELAY_MS = 120;
const MAX_EXPANDED_REFRESH_BRANCHES = 80;

function reasonLabel(reason: FolderRefreshReason): string {
    if (reason === 'watch') return 'Updated from file changes';
    if (reason === 'move') return 'Updated after move';
    if (reason === 'mutation') return 'Updated after file change';
    if (reason === 'git-operation') return 'Updated after git operation';
    if (reason === 'worktree-switch') return 'Updated worktree';
    if (reason === 'root') return 'Updated folder root';
    return 'Updated folder';
}

export function useFolderVisibleRefresh(input: UseFolderVisibleRefreshInput) {
    const {
        rootPath,
        expanded,
        source,
        loadDir,
        loadChildren,
        bumpGitRefresh,
        onGitRefresh,
        refreshWorktrees,
    } = input;
    const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
    const [watchStatus, setWatchStatus] = useState<string | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const refreshingRef = useRef(false);
    const queuedRefreshRef = useRef<{ reason: FolderRefreshReason; options: FolderVisibleRefreshOptions } | null>(null);
    const watchTimerRef = useRef<number | null>(null);

    const clearWatchTimer = useCallback(() => {
        if (watchTimerRef.current === null) return;
        window.clearTimeout(watchTimerRef.current);
        watchTimerRef.current = null;
    }, []);

    const runRefresh = useCallback(async (reason: FolderRefreshReason, options: FolderVisibleRefreshOptions = {}) => {
        if (rootPath === null) return;
        if (refreshingRef.current) {
            const queued = queuedRefreshRef.current;
            queuedRefreshRef.current = queued
                ? {
                    reason,
                    options: {
                        extraPaths: Array.from(new Set([
                            ...(queued.options.extraPaths ?? []),
                            ...(options.extraPaths ?? []),
                        ])),
                    },
                }
                : { reason, options };
            return;
        }
        refreshingRef.current = true;
        setIsRefreshing(true);
        setRefreshStatus(reason === 'watch' ? 'Refreshing changed files...' : 'Refreshing folder...');
        try {
            const expandedPaths = Array.from(new Set([...Array.from(expanded), ...(options.extraPaths ?? [])]))
                .slice(0, MAX_EXPANDED_REFRESH_BRANCHES);
            await loadDir(rootPath);
            for (const path of expandedPaths) await loadChildren(path, { force: true });
            bumpGitRefresh();
            onGitRefresh?.();
            refreshWorktrees();
            const skippedCount = Math.max(0, expanded.size - expandedPaths.length);
            setRefreshStatus(skippedCount > 0
                ? `${reasonLabel(reason)}; ${skippedCount} collapsed/overflow branches skipped`
                : reasonLabel(reason));
        } finally {
            refreshingRef.current = false;
            setIsRefreshing(false);
            const queuedRefresh = queuedRefreshRef.current;
            queuedRefreshRef.current = null;
            if (queuedRefresh) void runRefresh(queuedRefresh.reason, queuedRefresh.options);
        }
    }, [bumpGitRefresh, expanded, loadChildren, loadDir, onGitRefresh, refreshWorktrees, rootPath]);

    const refreshVisibleTree = useCallback(async (
        reason: FolderRefreshReason = 'manual',
        options: FolderVisibleRefreshOptions = {},
    ) => {
        await runRefresh(reason, options);
    }, [runRefresh]);

    const scheduleWatchRefresh = useCallback(() => {
        clearWatchTimer();
        watchTimerRef.current = window.setTimeout(() => {
            watchTimerRef.current = null;
            void runRefresh('watch');
        }, WATCH_REFRESH_DELAY_MS);
    }, [clearWatchTimer, runRefresh]);

    useEffect(() => {
        if (!source.watchDir || !source.onDirChange || rootPath === null) return;
        let cancelled = false;
        void (async () => {
            const result = await source.watchDir?.(rootPath);
            if (cancelled) return;
            if (result && !result.ok) setWatchStatus(`Watch disabled: ${result.error ?? 'failed to watch directory'}`);
            else setWatchStatus(null);
        })();
        const unsub = source.onDirChange(() => { scheduleWatchRefresh(); });
        return () => {
            cancelled = true;
            clearWatchTimer();
            unsub();
            void source.unwatchDir?.(rootPath);
        };
    }, [clearWatchTimer, rootPath, scheduleWatchRefresh, source]);

    return {
        isRefreshing,
        refreshStatus,
        watchStatus,
        refreshVisibleTree,
    };
}
