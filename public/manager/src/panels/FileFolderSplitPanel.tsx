import { useCallback, useRef, type ReactNode } from 'react';
import { PanelResizer } from './PanelResizer';
import { usePanelLayout } from './PanelLayoutProvider';
import type { FileFolderViewMode } from './types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type FileFolderSplitPanelProps = {
    /** DocPanel content (file pane, rendered left) */
    filePane: ReactNode;
    /** FolderPanel content (folder pane, rendered right) */
    folderPane: ReactNode;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Phase 014: Unified split body for the Files tab.
 *
 * Renders DocPanel (left) and FolderPanel (right) with a draggable vertical
 * splitter. The splitter drives SET_FILE_FOLDER_SPLIT_RATIO with threshold-
 * driven mode transitions:
 *
 * - splitRatio <= 0.12 -> folder-only (file pane hidden)
 * - splitRatio >= 0.88 -> file-only (folder pane hidden)
 * - otherwise -> split (both visible)
 *
 * When a pane hides, the other pane's state (FolderPanel session snapshot,
 * active file path) is preserved by the parent -- this component simply
 * controls visibility via CSS and dispatches ratio changes.
 */
export function FileFolderSplitPanel(props: FileFolderSplitPanelProps) {
    const { state, dispatch } = usePanelLayout();
    const ffl = state.rightPanel.fileFolderLayout;
    const mode: FileFolderViewMode = ffl.mode;
    const splitRatio = ffl.splitRatio;

    // Track the container width for delta-to-ratio conversion
    const containerRef = useRef<HTMLDivElement | null>(null);

    const handleSplitDelta = useCallback((delta: number) => {
        const container = containerRef.current;
        if (!container) return;
        const containerWidth = container.offsetWidth;
        if (containerWidth <= 0) return;
        const ratioDelta = delta / containerWidth;
        const currentRatio = state.rightPanel.fileFolderLayout.splitRatio;
        const newRatio = Math.max(0, Math.min(1, currentRatio + ratioDelta));
        dispatch({ type: 'SET_FILE_FOLDER_SPLIT_RATIO', ratio: newRatio });
    }, [dispatch, state.rightPanel.fileFolderLayout.splitRatio]);

    const handleSplitEnd = useCallback(() => {
        // Persistence is handled by the parent state-change listener
    }, []);

    // Compute inline flex styles for the panes
    const filePaneStyle: React.CSSProperties = mode === 'folder-only'
        ? { display: 'none' }
        : mode === 'file-only'
            ? { flex: '1 1 100%', minWidth: 0 }
            : { flex: `0 0 ${(splitRatio * 100).toFixed(2)}%`, minWidth: 0 };

    const folderPaneStyle: React.CSSProperties = mode === 'file-only'
        ? { display: 'none' }
        : mode === 'folder-only'
            ? { flex: '1 1 100%', minWidth: 0 }
            : { flex: '1 1 0%', minWidth: 0 };

    const showSplitter = mode === 'split';

    return (
        <div
            className="file-folder-split-panel"
            ref={containerRef}
            data-mode={mode}
        >
            <div className="file-folder-split-file-pane" style={filePaneStyle}>
                {props.filePane}
            </div>
            {showSplitter && (
                <PanelResizer
                    direction="horizontal"
                    onDelta={handleSplitDelta}
                    onEnd={handleSplitEnd}
                    className="file-folder-split-resizer"
                />
            )}
            <div className="file-folder-split-folder-pane" style={folderPaneStyle}>
                {props.folderPane}
            </div>
        </div>
    );
}
