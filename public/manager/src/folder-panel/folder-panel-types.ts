import type { FolderMoveResult, FolderMutationResult, FolderWatchResult } from '../panels/desktop-bridge';

export type FolderPanelSourceKind = 'electron-folder' | 'notes-vault';

export type FolderPanelEntry = {
    name: string;
    path: string;
    kind: 'file' | 'directory';
    size: number;
};

export type FolderPanelMoveResult = FolderMoveResult;

export type FolderPanelSource = {
    kind: FolderPanelSourceKind;
    label: string;
    canPickRoot: boolean;
    getInitialRoot: () => Promise<string | null>;
    pickRoot?: () => Promise<string | null>;
    authorizeRoot?: (rootPath: string) => Promise<string>;
    registerGitWorktreeRoot?: (folderPanelRoot: string, repoRoot: string | undefined, worktreePath: string) => Promise<void>;
    listDir: (path: string) => Promise<FolderPanelEntry[]>;
    readFile?: (path: string) => Promise<{ content: string; binary?: boolean }>;
    movePath?: (sourcePath: string, targetDirectory: string) => Promise<FolderPanelMoveResult>;
    createFile?: (parentDirectory: string, name: string) => Promise<FolderMutationResult>;
    createFolder?: (parentDirectory: string, name: string) => Promise<FolderMutationResult>;
    renamePath?: (sourcePath: string, name: string) => Promise<FolderMutationResult>;
    revealPath?: (path: string) => Promise<void>;
    copyBasePath?: string | null;
    watchDir?: (path: string) => Promise<FolderWatchResult>;
    unwatchDir?: (path: string) => Promise<FolderWatchResult>;
    onDirChange?: (cb: (path: string) => void) => () => void;
};

export type FolderPanelRootState = {
    rootPath: string | null;
    entries: FolderPanelEntry[];
};

export type FolderPanelRowDecoration = {
    className?: string;
    label?: string;
    title?: string;
};
