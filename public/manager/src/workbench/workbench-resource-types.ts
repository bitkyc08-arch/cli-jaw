export type WorkbenchResourceSource = 'folder' | 'diff' | 'doc' | 'preview' | 'drop' | 'code';

export type WorkbenchResourceState = {
    folderRootPath: string | null;
    repoRootPath: string | null;
    worktreeRootPath: string | null;
    activeResourcePath: string | null;
    activeResourceSource: WorkbenchResourceSource | null;
    fileRefreshVersion: number;
    gitRefreshVersion: number;
};

export type WorkbenchResourceActions = {
    setFolderRootPath: (path: string | null) => void;
    setRepoRootPath: (path: string | null) => void;
    setWorktreeRootPath: (path: string | null) => void;
    setActiveResource: (path: string | null, source: WorkbenchResourceSource | null) => void;
    bumpFileRefresh: () => void;
    bumpGitRefresh: () => void;
};
