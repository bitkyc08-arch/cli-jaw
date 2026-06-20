import type { RefObject } from 'react';
import type { FolderPanelEntry, FolderPanelRowDecoration, FolderPanelSourceKind } from './folder-panel-types';
import { FolderTreeRows } from './FolderTreeRows';
import { FolderUnavailableRoot } from './FolderUnavailableRoot';
import type { FolderInlineMutationState } from './use-folder-mutations';
import type { FolderDragSelection, FolderSelectionActions } from './use-folder-selection';

type FolderPanelTreeProps = {
    treeRef: RefObject<HTMLDivElement | null>;
    rootPath: string | null;
    error: string | null;
    entries: FolderPanelEntry[];
    expanded: Set<string>;
    childrenCache: Map<string, FolderPanelEntry[]>;
    folderSelection: FolderSelectionActions;
    decorationsByPath: Map<string, FolderPanelRowDecoration>;
    dropTargetPath: string | null;
    dragSelection: FolderDragSelection | null;
    inlineMutation: FolderInlineMutationState | null;
    isMutating: boolean;
    canUseNativeActions: boolean;
    sourceKind: FolderPanelSourceKind;
    unavailableRoot: { path: string; error: string } | null;
    setDragSelection: (selection: FolderDragSelection | null) => void;
    setDropTargetPath: (path: string | null) => void;
    requestMove: (sourceEntry: FolderPanelEntry, targetEntry: FolderPanelEntry) => void;
    handleEntryKeyDown: (event: React.KeyboardEvent, entry: FolderPanelEntry) => void;
    selectEntry: (entry: FolderPanelEntry, options?: { range?: boolean; toggle?: boolean; preview?: boolean }) => void;
    toggleEntryExpansion: (entry: FolderPanelEntry) => void;
    openFileEntry: (entry: FolderPanelEntry) => void;
    openContextMenu: (entry: FolderPanelEntry, x: number, y: number) => void;
    submitInlineMutation: (name: string) => void;
    cancelInlineMutation: () => void;
    onPickFolder: () => void;
    onClearUnavailableRoot: () => void;
};

export function FolderPanelTree(props: FolderPanelTreeProps) {
    return (
        <div
            ref={props.treeRef}
            className={props.rootPath === null ? 'folder-tree folder-empty-root' : 'folder-tree'}
            role="tree"
            aria-multiselectable="true"
        >
            <FolderTreeRows
                entries={props.entries}
                parentPath={props.rootPath}
                depth={0}
                expanded={props.expanded}
                childrenCache={props.childrenCache}
                selectedPaths={props.folderSelection.selectedPaths}
                focusedPath={props.folderSelection.selection.focusedPath}
                decorationsByPath={props.decorationsByPath}
                dropTargetPath={props.dropTargetPath}
                dragSelection={props.dragSelection}
                inlineMutation={props.inlineMutation}
                isMutating={props.isMutating}
                canUseNativeActions={props.canUseNativeActions}
                setDragSelection={props.setDragSelection}
                setDropTargetPath={props.setDropTargetPath}
                getDragSelectionFor={props.folderSelection.getDragSelectionFor}
                requestMove={props.requestMove}
                handleEntryKeyDown={props.handleEntryKeyDown}
                selectEntry={props.selectEntry}
                toggleEntryExpansion={props.toggleEntryExpansion}
                openFileEntry={props.openFileEntry}
                openContextMenu={props.openContextMenu}
                submitInlineMutation={props.submitInlineMutation}
                cancelInlineMutation={props.cancelInlineMutation}
            />
            {props.rootPath === null && !props.error && (
                <div className="folder-empty-root__content">Choose a folder to browse files.</div>
            )}
            {props.unavailableRoot && (
                <FolderUnavailableRoot
                    path={props.unavailableRoot.path}
                    error={props.unavailableRoot.error}
                    onOpenFolder={props.onPickFolder}
                    onClear={props.onClearUnavailableRoot}
                />
            )}
            {props.entries.length === 0 && !props.inlineMutation && !props.error && !props.unavailableRoot && props.rootPath !== null && (
                <div className="folder-empty">{props.sourceKind === 'notes-vault' ? 'No notes in vault' : 'Empty directory'}</div>
            )}
        </div>
    );
}
