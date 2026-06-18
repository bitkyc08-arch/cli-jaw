import type { NotesTreeEntry } from '../notes/notes-types';
import type { FolderPanelSessionState } from './folder-panel-session';

export type FolderPanelProps = {
    selectedFilePath?: string | null | undefined;
    externalRootPath?: string | null | undefined;
    repoRootPath?: string | null | undefined;
    gitRefreshVersion?: number | undefined;
    notesTree?: NotesTreeEntry[] | undefined;
    notesRoot?: string | null | undefined;
    onRootChange?: ((path: string | null) => void) | undefined;
    onRepoRootChange?: ((path: string | null) => void) | undefined;
    onGitRefresh?: (() => void) | undefined;
    onPreviewFile?: ((path: string) => void) | undefined;
    sessionState?: FolderPanelSessionState | null | undefined;
    onSessionStateChange?: ((state: FolderPanelSessionState) => void) | undefined;
};
