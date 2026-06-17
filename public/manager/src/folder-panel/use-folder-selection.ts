import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FolderPanelEntry } from './folder-sources';
import {
    emptyFolderSelection,
    flattenVisibleFolderEntries,
    moveFolderKeyboardSelection,
    pruneFolderSelection,
    selectFolderPath,
    selectedEntriesInVisibleOrder,
    type FolderDragSelection,
    type FolderSelectionState,
    type SelectionDirection,
} from './folder-selection';

export type { FolderDragSelection, FolderSelectionState, SelectionDirection };

export type FolderSelectionActions = {
    selection: FolderSelectionState;
    visibleEntries: FolderPanelEntry[];
    visiblePaths: string[];
    selectedPaths: Set<string>;
    selectedPath: string | null;
    selectedEntries: FolderPanelEntry[];
    selectedEntry: FolderPanelEntry | null;
    selectEntry: (entry: FolderPanelEntry, options?: { range?: boolean; toggle?: boolean; preview?: boolean }) => void;
    selectOnlyPath: (path: string | null) => void;
    resetSelection: () => void;
    moveKeyboardSelection: (direction: SelectionDirection, extend: boolean) => void;
    getDragSelectionFor: (entry: FolderPanelEntry) => FolderDragSelection;
};

export function useFolderSelection(input: {
    entries: FolderPanelEntry[];
    childrenCache: Map<string, FolderPanelEntry[]>;
    expanded: Set<string>;
    onPreviewFile?: ((path: string) => void) | undefined;
}): FolderSelectionActions {
    const onPreviewFile = input.onPreviewFile;
    const [selection, setSelection] = useState<FolderSelectionState>(emptyFolderSelection);
    const visibleEntries = useMemo(
        () => flattenVisibleFolderEntries(input.entries, input.childrenCache, input.expanded),
        [input.childrenCache, input.entries, input.expanded],
    );
    const visiblePaths = useMemo(() => visibleEntries.map(entry => entry.path), [visibleEntries]);
    const selectedPaths = useMemo(() => new Set(selection.selectedPaths), [selection.selectedPaths]);
    const selectedEntries = useMemo(
        () => selectedEntriesInVisibleOrder(visibleEntries, selectedPaths),
        [selectedPaths, visibleEntries],
    );
    const selectedPath = selection.focusedPath ?? selectedEntries[0]?.path ?? null;
    const selectedEntry = visibleEntries.find(entry => entry.path === selectedPath) ?? selectedEntries[0] ?? null;

    useEffect(() => {
        setSelection(current => pruneFolderSelection(current, visiblePaths));
    }, [visiblePaths]);

    const selectEntry = useCallback((entry: FolderPanelEntry, options: { range?: boolean; toggle?: boolean; preview?: boolean } = {}) => {
        setSelection(current => selectFolderPath(current, entry.path, visiblePaths, options));
        if (entry.kind === 'file' && options.preview !== false) onPreviewFile?.(entry.path);
    }, [onPreviewFile, visiblePaths]);

    const selectOnlyPath = useCallback((path: string | null) => {
        setSelection(path && visiblePaths.includes(path)
            ? { selectedPaths: [path], focusedPath: path, anchorPath: path }
            : emptyFolderSelection);
    }, [visiblePaths]);

    const resetSelection = useCallback(() => {
        setSelection(emptyFolderSelection);
    }, []);

    const moveKeyboardSelection = useCallback((direction: SelectionDirection, extend: boolean) => {
        setSelection(current => moveFolderKeyboardSelection(current, visiblePaths, direction, extend));
    }, [visiblePaths]);

    const getDragSelectionFor = useCallback((entry: FolderPanelEntry): FolderDragSelection => {
        if (selectedPaths.has(entry.path)) return { primaryEntry: entry, entries: selectedEntries };
        return { primaryEntry: entry, entries: [entry] };
    }, [selectedEntries, selectedPaths]);

    return {
        selection,
        visibleEntries,
        visiblePaths,
        selectedPaths,
        selectedPath,
        selectedEntries,
        selectedEntry,
        selectEntry,
        selectOnlyPath,
        resetSelection,
        moveKeyboardSelection,
        getDragSelectionFor,
    };
}
