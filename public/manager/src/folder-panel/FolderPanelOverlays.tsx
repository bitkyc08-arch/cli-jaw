import type { FolderPanelEntry } from './folder-panel-types';
import { FolderContextMenu } from './FolderContextMenu';
import { FolderMoveConfirmDialog } from './FolderMoveConfirmDialog';
import { FolderMutationDialog } from './FolderMutationDialog';

export type FolderMutationDialogState = {
    kind: 'file' | 'directory' | 'rename';
    title: string;
    initialName: string;
    confirmLabel: string;
};

type FolderPanelOverlaysProps = {
    pendingMove: { source: FolderPanelEntry; target: FolderPanelEntry } | null;
    contextMenu: { entry: FolderPanelEntry; x: number; y: number } | null;
    mutationDialog: FolderMutationDialogState | null;
    isMoving: boolean;
    isMutating: boolean;
    skipMoveConfirmChecked: boolean;
    canReveal: boolean;
    canRefresh: boolean;
    canMutate: boolean;
    onSkipMoveConfirmCheckedChange: (checked: boolean) => void;
    onCancelMove: () => void;
    onConfirmMove: () => void;
    onCopyContextPath: () => void;
    onCopyContextRelativePath: () => void;
    onRevealContextPath: () => void;
    onRefreshContext: () => void;
    onCreateContextFile: () => void;
    onCreateContextFolder: () => void;
    onRenameContextPath: () => void;
    onCancelMutation: () => void;
    onSubmitMutation: (name: string) => void;
};

export function FolderPanelOverlays(props: FolderPanelOverlaysProps) {
    return (
        <>
            {props.pendingMove && (
                <FolderMoveConfirmDialog
                    source={props.pendingMove.source}
                    target={props.pendingMove.target}
                    busy={props.isMoving}
                    skipChecked={props.skipMoveConfirmChecked}
                    onSkipCheckedChange={props.onSkipMoveConfirmCheckedChange}
                    onCancel={props.onCancelMove}
                    onConfirm={props.onConfirmMove}
                />
            )}
            {props.contextMenu && (
                <FolderContextMenu
                    entry={props.contextMenu.entry}
                    x={props.contextMenu.x}
                    y={props.contextMenu.y}
                    canReveal={props.canReveal}
                    canRefresh={props.canRefresh}
                    canMutate={props.canMutate}
                    onCopyPath={props.onCopyContextPath}
                    onCopyRelativePath={props.onCopyContextRelativePath}
                    onReveal={props.onRevealContextPath}
                    onRefresh={props.onRefreshContext}
                    onCreateFile={props.onCreateContextFile}
                    onCreateFolder={props.onCreateContextFolder}
                    onRename={props.onRenameContextPath}
                />
            )}
            {props.mutationDialog && (
                <FolderMutationDialog
                    title={props.mutationDialog.title}
                    initialName={props.mutationDialog.initialName}
                    confirmLabel={props.mutationDialog.confirmLabel}
                    busy={props.isMutating}
                    onCancel={props.onCancelMutation}
                    onSubmit={props.onSubmitMutation}
                />
            )}
        </>
    );
}
