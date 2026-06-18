import { useCallback, useState } from 'react';
import type { WorkbenchResourceActions, WorkbenchResourceSource, WorkbenchResourceState } from './workbench-resource-types';

type UseWorkbenchResourceStateInput = {
    initialFolderRootPath: string | null;
};

export function useWorkbenchResourceState(input: UseWorkbenchResourceStateInput): WorkbenchResourceState & WorkbenchResourceActions {
    const [folderRootPath, setFolderRootPath] = useState<string | null>(input.initialFolderRootPath);
    const [repoRootPath, setRepoRootPath] = useState<string | null>(null);
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

    return {
        folderRootPath,
        repoRootPath,
        worktreeRootPath,
        activeResourcePath,
        activeResourceSource,
        fileRefreshVersion,
        gitRefreshVersion,
        setFolderRootPath,
        setRepoRootPath,
        setWorktreeRootPath,
        setActiveResource,
        bumpFileRefresh,
        bumpGitRefresh,
    };
}
