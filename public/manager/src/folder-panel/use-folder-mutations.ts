import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { FolderMutationDialogState } from './FolderPanelOverlays';
import { parentPath } from './folder-panel-state';
import type { FolderPanelEntry, FolderPanelSource } from './folder-panel-types';

type FolderMutationSelection = {
    selectOnlyPath: (path: string) => void;
};

type UseFolderMutationsInput = {
    rootPath: string | null;
    selectedEntry: FolderPanelEntry | null;
    selectedFilePath?: string | null | undefined;
    source: FolderPanelSource;
    folderSelection: FolderMutationSelection;
    refreshAfterMutation: (parentDirectory: string, focusPath: string | null, extraDroppedPaths?: string[]) => Promise<void>;
    renamedPreviewPath: (currentPath: string | null | undefined, oldPath: string, newPath: string) => string | null;
    onPreviewFile?: ((path: string) => void) | undefined;
    closeContextMenu: () => void;
    setExpanded: Dispatch<SetStateAction<Set<string>>>;
    setActionStatus: (status: string | null) => void;
    setError: (error: string | null) => void;
};

export function useFolderMutations(input: UseFolderMutationsInput) {
    const [mutationDialog, setMutationDialog] = useState<FolderMutationDialogState | null>(null);
    const [isMutating, setIsMutating] = useState(false);

    const mutationParentDirectory = useCallback((): string | null => {
        if (!input.rootPath) return null;
        if (!input.selectedEntry) return input.rootPath;
        return input.selectedEntry.kind === 'directory' ? input.selectedEntry.path : parentPath(input.selectedEntry.path);
    }, [input.rootPath, input.selectedEntry]);

    const requestCreateEntry = useCallback((kind: 'file' | 'directory') => {
        const parentDirectory = mutationParentDirectory();
        if (!parentDirectory) return;
        if (kind === 'file' && !input.source.createFile) return;
        if (kind === 'directory' && !input.source.createFolder) return;
        setMutationDialog({
            kind,
            title: kind === 'file' ? 'New File' : 'New Folder',
            initialName: kind === 'file' ? 'untitled.txt' : 'untitled',
            confirmLabel: 'Create',
        });
        input.closeContextMenu();
    }, [input, mutationParentDirectory]);

    const submitCreateEntry = useCallback(async (kind: 'file' | 'directory', name: string) => {
        const parentDirectory = mutationParentDirectory();
        if (!parentDirectory) return;
        const create = kind === 'file' ? input.source.createFile : input.source.createFolder;
        if (!create) return;
        const label = kind === 'file' ? 'New file name' : 'New folder name';
        if (!name.trim()) {
            input.setError(`${label} required`);
            return;
        }
        setIsMutating(true);
        try {
            const result = await create(parentDirectory, name.trim());
            const entry = result.entry;
            if (kind === 'directory' && input.selectedEntry?.path === parentDirectory) {
                input.setExpanded(prev => new Set(prev).add(parentDirectory));
            }
            input.setActionStatus(kind === 'file' ? 'Created file' : 'Created folder');
            input.setError(null);
            setMutationDialog(null);
            await input.refreshAfterMutation(parentDirectory, entry?.path ?? null);
        } catch (err) {
            input.setError((err as Error).message);
        } finally {
            setIsMutating(false);
        }
    }, [input, mutationParentDirectory]);

    const requestRenameSelectedEntry = useCallback(() => {
        if (!input.selectedEntry || !input.source.renamePath) return;
        setMutationDialog({
            kind: 'rename',
            title: 'Rename',
            initialName: input.selectedEntry.name,
            confirmLabel: 'Rename',
        });
        input.closeContextMenu();
    }, [input]);

    const submitRenameSelectedEntry = useCallback(async (name: string) => {
        if (!input.selectedEntry || !input.source.renamePath) return;
        const nextName = name.trim();
        if (!nextName || nextName === input.selectedEntry.name) {
            setMutationDialog(null);
            return;
        }
        setIsMutating(true);
        try {
            const result = await input.source.renamePath(input.selectedEntry.path, nextName);
            const parentDirectory = parentPath(input.selectedEntry.path);
            const nextPath = result.entry?.path ?? null;
            const nextPreviewPath = nextPath ? input.renamedPreviewPath(input.selectedFilePath, input.selectedEntry.path, nextPath) : null;
            input.setActionStatus('Renamed');
            input.setError(null);
            setMutationDialog(null);
            await input.refreshAfterMutation(parentDirectory, nextPath, [input.selectedEntry.path]);
            if (nextPreviewPath) input.onPreviewFile?.(nextPreviewPath);
        } catch (err) {
            input.setError((err as Error).message);
        } finally {
            setIsMutating(false);
        }
    }, [input]);

    const submitMutation = useCallback((name: string) => {
        if (!mutationDialog) return;
        if (mutationDialog.kind === 'rename') void submitRenameSelectedEntry(name);
        else void submitCreateEntry(mutationDialog.kind, name);
    }, [mutationDialog, submitCreateEntry, submitRenameSelectedEntry]);

    return {
        mutationDialog,
        isMutating,
        requestCreateEntry,
        requestRenameSelectedEntry,
        submitMutation,
        cancelMutation: () => setMutationDialog(null),
    };
}
