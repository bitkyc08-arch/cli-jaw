import { useCallback, useRef, useState } from 'react';
import type { WorkbenchRepoRootMode, WorkbenchResourceActions, WorkbenchResourceSource, WorkbenchResourceState } from './workbench-resource-types';

type UseWorkbenchResourceStateInput = {
    initialFolderRootPath: string | null;
};

export function useWorkbenchResourceState(input: UseWorkbenchResourceStateInput): WorkbenchResourceState & WorkbenchResourceActions {
    const [folderRootPath, setFolderRootPath] = useState<string | null>(input.initialFolderRootPath);
    const [repoRootPath, setRepoRootPathState] = useState<string | null>(null);
    const [repoRootMode, setRepoRootMode] = useState<WorkbenchRepoRootMode>('instance');
    const [worktreeRootPath, setWorktreeRootPath] = useState<string | null>(null);
    const [activeResourcePath, setActiveResourcePath] = useState<string | null>(null);
    const [activeResourceSource, setActiveResourceSource] = useState<WorkbenchResourceSource | null>(null);
    const [fileRefreshVersion, setFileRefreshVersion] = useState(0);
    const [gitRefreshVersion, setGitRefreshVersion] = useState(0);

    const setActiveResource = useCallback((path: string | null, source: WorkbenchResourceSource | null) => {
        setActiveResourcePath(path);
        setActiveResourceSource(path === null ? null : source);
    }, []);

    const bumpFileRefresh = useCallback(() => setFileRefreshVersion(version => version + 1), []);
    const bumpGitRefresh = useCallback(() => setGitRefreshVersion(version => version + 1), []);
    const repoRootModeRef = useRef<WorkbenchRepoRootMode>('instance');
    const setRepoRootPath = useCallback((path: string | null, mode: WorkbenchRepoRootMode = 'instance') => {
        if (mode === 'manual') {
            repoRootModeRef.current = 'manual';
            setRepoRootMode('manual');
            setRepoRootPathState(path);
            return;
        }
        if (repoRootModeRef.current === 'manual') return;
        setRepoRootPathState(path);
    }, []);
    const followInstanceRepoRoot = useCallback((path: string | null) => {
        repoRootModeRef.current = 'instance';
        setRepoRootMode('instance');
        setRepoRootPathState(path);
    }, []);

    return {
        folderRootPath,
        repoRootPath,
        repoRootMode,
        worktreeRootPath,
        activeResourcePath,
        activeResourceSource,
        fileRefreshVersion,
        gitRefreshVersion,
        setFolderRootPath,
        setRepoRootPath,
        followInstanceRepoRoot,
        setWorktreeRootPath,
        setActiveResource,
        bumpFileRefresh,
        bumpGitRefresh,
    };
}
