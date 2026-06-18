import type { FolderPanelEntry } from './folder-sources';
import { emptyFolderSelection, type FolderSelectionState } from './folder-selection';

export type FolderPanelChildrenCacheSnapshot = Array<[string, FolderPanelEntry[]]>;

export type FolderPanelSessionState = {
    rootPath: string | null;
    entries: FolderPanelEntry[];
    expandedPaths: string[];
    childrenCache: FolderPanelChildrenCacheSnapshot;
    selection: FolderSelectionState;
};

export function emptyFolderPanelSessionState(): FolderPanelSessionState {
    return {
        rootPath: null,
        entries: [],
        expandedPaths: [],
        childrenCache: [],
        selection: emptyFolderSelection,
    };
}

export function childrenCacheToSnapshot(cache: Map<string, FolderPanelEntry[]>): FolderPanelChildrenCacheSnapshot {
    return Array.from(cache.entries());
}

export function snapshotToChildrenCache(snapshot: FolderPanelChildrenCacheSnapshot): Map<string, FolderPanelEntry[]> {
    return new Map(snapshot);
}

export function compatibleFolderPanelSession(
    session: FolderPanelSessionState | null,
    externalRootPath: string | null,
): FolderPanelSessionState | null {
    if (!session) return null;
    if (externalRootPath && session.rootPath !== externalRootPath) return null;
    return session;
}

export function folderPanelSessionFromState(input: {
    rootPath: string | null;
    entries: FolderPanelEntry[];
    expanded: Set<string>;
    childrenCache: Map<string, FolderPanelEntry[]>;
    selection: FolderSelectionState;
}): FolderPanelSessionState {
    return {
        rootPath: input.rootPath,
        entries: input.entries,
        expandedPaths: Array.from(input.expanded),
        childrenCache: childrenCacheToSnapshot(input.childrenCache),
        selection: input.selection,
    };
}
