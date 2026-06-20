import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { parentPath } from './folder-panel-state';
import type { FolderPanelEntry, FolderPanelSource } from './folder-panel-types';

export type FolderInlineMutationState = {
    kind: 'file' | 'directory' | 'rename';
    parentDirectory: string;
    targetPath?: string | undefined;
    initialName: string;
};

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
    const [inlineMutation, setInlineMutation] = useState<FolderInlineMutationState | null>(null);
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
        input.setExpanded(prev => new Set(prev).add(parentDirectory));
        setInlineMutation({
            kind,
            parentDirectory,
            initialName: kind === 'file' ? 'untitled.txt' : 'untitled',
        });
        input.closeContextMenu();
    }, [input, mutationParentDirectory]);

    const submitCreateEntry = useCallback(async (kind: 'file' | 'directory', parentDirectory: string, name: string) => {
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
            setInlineMutation(null);
            await input.refreshAfterMutation(parentDirectory, entry?.path ?? null);
        } catch (err) {
            input.setError((err as Error).message);
        } finally {
            setIsMutating(false);
        }
    }, [input]);

    const requestRenameSelectedEntry = useCallback(() => {
        if (!input.selectedEntry || !input.source.renamePath) return;
        setInlineMutation({
            kind: 'rename',
            parentDirectory: parentPath(input.selectedEntry.path),
            targetPath: input.selectedEntry.path,
            initialName: input.selectedEntry.name,
        });
        input.closeContextMenu();
    }, [input]);

    const submitRenameEntry = useCallback(async (mutation: FolderInlineMutationState, name: string) => {
        if (!mutation.targetPath || !input.source.renamePath) return;
        const nextName = name.trim();
        if (!nextName || nextName === mutation.initialName) {
            setInlineMutation(null);
            return;
        }
        setIsMutating(true);
        try {
            const result = await input.source.renamePath(mutation.targetPath, nextName);
            const parentDirectory = mutation.parentDirectory;
            const nextPath = result.entry?.path ?? null;
            const nextPreviewPath = nextPath ? input.renamedPreviewPath(input.selectedFilePath, mutation.targetPath, nextPath) : null;
            input.setActionStatus('Renamed');
            input.setError(null);
            setInlineMutation(null);
            await input.refreshAfterMutation(parentDirectory, nextPath, [mutation.targetPath]);
            if (nextPreviewPath) input.onPreviewFile?.(nextPreviewPath);
        } catch (err) {
            input.setError((err as Error).message);
        } finally {
            setIsMutating(false);
        }
    }, [input]);

    const submitInlineMutation = useCallback((name: string) => {
        if (!inlineMutation) return;
        if (inlineMutation.kind === 'rename') void submitRenameEntry(inlineMutation, name);
        else void submitCreateEntry(inlineMutation.kind, inlineMutation.parentDirectory, name);
    }, [inlineMutation, submitCreateEntry, submitRenameEntry]);

    return {
        inlineMutation,
        isMutating,
        requestCreateEntry,
        requestRenameSelectedEntry,
        submitInlineMutation,
        cancelInlineMutation: () => setInlineMutation(null),
    };
}
