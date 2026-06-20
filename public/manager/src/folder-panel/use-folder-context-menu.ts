import { useCallback, useEffect, useState } from 'react';
import type { FolderPanelEntry } from './folder-panel-types';

export type FolderContextMenuState = {
    entry: FolderPanelEntry;
    x: number;
    y: number;
};

type UseFolderContextMenuInput = {
    selectedPaths: Set<string>;
    selectOnlyPath: (path: string) => void;
};

export function useFolderContextMenu(input: UseFolderContextMenuInput) {
    const [contextMenu, setContextMenu] = useState<FolderContextMenuState | null>(null);
    const closeContextMenu = useCallback(() => setContextMenu(null), []);
    const openContextMenu = useCallback((entry: FolderPanelEntry, x: number, y: number) => {
        if (!input.selectedPaths.has(entry.path)) input.selectOnlyPath(entry.path);
        setContextMenu({ entry, x, y });
    }, [input]);

    useEffect(() => {
        if (!contextMenu) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setContextMenu(null);
        };
        const closeOnFrameFocus = () => {
            if (document.activeElement instanceof HTMLIFrameElement) setContextMenu(null);
        };
        window.addEventListener('pointerdown', closeContextMenu);
        window.addEventListener('keydown', closeOnEscape);
        window.addEventListener('blur', closeOnFrameFocus);
        return () => {
            window.removeEventListener('pointerdown', closeContextMenu);
            window.removeEventListener('keydown', closeOnEscape);
            window.removeEventListener('blur', closeOnFrameFocus);
        };
    }, [closeContextMenu, contextMenu]);

    return {
        contextMenu,
        closeContextMenu,
        openContextMenu,
    };
}
