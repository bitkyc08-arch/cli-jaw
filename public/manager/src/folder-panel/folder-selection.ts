import type { FolderPanelEntry } from './folder-sources';

export type SelectionDirection = 'up' | 'down';

export type FolderSelectionState = {
    selectedPaths: string[];
    focusedPath: string | null;
    anchorPath: string | null;
};

export type FolderDragSelection = {
    primaryEntry: FolderPanelEntry;
    entries: FolderPanelEntry[];
};

export const emptyFolderSelection: FolderSelectionState = {
    selectedPaths: [],
    focusedPath: null,
    anchorPath: null,
};

export function flattenVisibleFolderEntries(
    entries: FolderPanelEntry[],
    childrenCache: Map<string, FolderPanelEntry[]>,
    expanded: Set<string>,
): FolderPanelEntry[] {
    const visible: FolderPanelEntry[] = [];
    const visit = (items: FolderPanelEntry[]) => {
        for (const entry of items) {
            visible.push(entry);
            if (entry.kind === 'directory' && expanded.has(entry.path)) {
                visit(childrenCache.get(entry.path) ?? []);
            }
        }
    };
    visit(entries);
    return visible;
}

export function pruneFolderSelection(state: FolderSelectionState, visiblePaths: string[]): FolderSelectionState {
    const visibleSet = new Set(visiblePaths);
    const selectedPaths = state.selectedPaths.filter(path => visibleSet.has(path));
    const focusedPath = state.focusedPath && visibleSet.has(state.focusedPath) ? state.focusedPath : (selectedPaths[0] ?? null);
    const anchorPath = state.anchorPath && visibleSet.has(state.anchorPath) ? state.anchorPath : focusedPath;
    return { selectedPaths, focusedPath, anchorPath };
}

export function selectFolderPath(
    state: FolderSelectionState,
    path: string,
    visiblePaths: string[],
    options: { range?: boolean; toggle?: boolean } = {},
): FolderSelectionState {
    if (!visiblePaths.includes(path)) return state;
    if (options.range && state.anchorPath && visiblePaths.includes(state.anchorPath)) {
        return {
            selectedPaths: rangePaths(visiblePaths, state.anchorPath, path),
            focusedPath: path,
            anchorPath: state.anchorPath,
        };
    }
    if (options.toggle) {
        const selected = new Set(state.selectedPaths);
        if (selected.has(path)) selected.delete(path);
        else selected.add(path);
        if (selected.size === 0) selected.add(path);
        return {
            selectedPaths: visiblePaths.filter(itemPath => selected.has(itemPath)),
            focusedPath: path,
            anchorPath: path,
        };
    }
    return {
        selectedPaths: [path],
        focusedPath: path,
        anchorPath: path,
    };
}

export function moveFolderKeyboardSelection(
    state: FolderSelectionState,
    visiblePaths: string[],
    direction: SelectionDirection,
    extend: boolean,
): FolderSelectionState {
    if (visiblePaths.length === 0) return emptyFolderSelection;
    const current = state.focusedPath && visiblePaths.includes(state.focusedPath)
        ? state.focusedPath
        : (state.selectedPaths.find(path => visiblePaths.includes(path)) ?? visiblePaths[0]);
    const currentIndex = visiblePaths.indexOf(current);
    const nextIndex = Math.max(0, Math.min(visiblePaths.length - 1, currentIndex + (direction === 'down' ? 1 : -1)));
    const nextPath = visiblePaths[nextIndex]!;
    if (extend) {
        const anchorPath = state.anchorPath && visiblePaths.includes(state.anchorPath) ? state.anchorPath : current;
        return {
            selectedPaths: rangePaths(visiblePaths, anchorPath, nextPath),
            focusedPath: nextPath,
            anchorPath,
        };
    }
    return {
        selectedPaths: [nextPath],
        focusedPath: nextPath,
        anchorPath: nextPath,
    };
}

export function selectedEntriesInVisibleOrder(visibleEntries: FolderPanelEntry[], selectedPaths: Set<string>): FolderPanelEntry[] {
    return visibleEntries.filter(entry => selectedPaths.has(entry.path));
}

function rangePaths(visiblePaths: string[], fromPath: string, toPath: string): string[] {
    const from = visiblePaths.indexOf(fromPath);
    const to = visiblePaths.indexOf(toPath);
    if (from < 0 || to < 0) return [toPath];
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return visiblePaths.slice(start, end + 1);
}
