import { useEffect, useRef } from 'react';
import { isDescendantPath } from './folder-panel-state';

type UseFolderPreviewSyncInput = {
    selectedFilePath: string | null | undefined;
    rootPath: string | null;
    selectedPath: string | null;
    visiblePaths: string[];
    selectOnlyPath: (path: string | null) => void;
};

/**
 * Mirrors the externally-driven preview file (DocPanel/DiffPanel selection) into
 * the folder tree's visible-row selection, WITHOUT clobbering local row clicks.
 *
 * The sync only fires when the external preview path actually changes. A local
 * row click changes `selectedPath` but not `selectedFilePath`, so the guard
 * leaves the user's selection untouched (the 990461c1 selection-lock fix). When
 * the preview path is cleared/changes to a non-visible or out-of-root file, the
 * current selection is left as-is rather than being reset.
 */
export function useFolderPreviewSync(input: UseFolderPreviewSyncInput): void {
    const { selectedFilePath, rootPath, selectedPath, visiblePaths, selectOnlyPath } = input;
    const syncedPreviewPathRef = useRef<string | null>(null);

    useEffect(() => {
        const previewPath = selectedFilePath ?? null;
        const previewPathChanged = previewPath !== syncedPreviewPathRef.current;
        if (previewPathChanged) syncedPreviewPathRef.current = previewPath;
        if (!previewPathChanged && selectedPath) return;
        if (!previewPath || !rootPath) return;
        if (!isDescendantPath(rootPath, previewPath)) return;
        if (previewPath === selectedPath) return;
        if (!visiblePaths.includes(previewPath)) return;
        selectOnlyPath(previewPath);
    }, [rootPath, selectOnlyPath, selectedFilePath, selectedPath, visiblePaths]);
}
