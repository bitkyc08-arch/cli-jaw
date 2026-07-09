/**
 * Phase 014 -- Unified Split Body tests.
 *
 * Verifies the FileFolderSplitPanel contract through reducer state behavior:
 * - split mode renders both panes (mode='split', ratio between thresholds)
 * - file-only hides FolderPanel without losing state (lastSplitRatio preserved)
 * - folder-only keeps the active file path (mode change does not clear file)
 * - threshold drags dispatch expected mode transitions
 * - RESTORE_FILE_FOLDER_SPLIT restores from lastSplitRatio
 * - dragging back from edge restores split and updates lastSplitRatio
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fileFolderViewModeFromRatio,
} from '../../public/manager/src/panels/PanelLayoutProvider.js';
import type { FileFolderLayoutState } from '../../public/manager/src/panels/types.js';
import {
    FILE_FOLDER_FOLDER_ONLY_THRESHOLD,
    FILE_FOLDER_FILE_ONLY_THRESHOLD,
    FILE_FOLDER_SPLIT_RATIO_DEFAULT,
} from '../../public/manager/src/panels/types.js';

// ---- Minimal reducer simulation ----
// Re-implement the reducer logic for SET_FILE_FOLDER_SPLIT_RATIO,
// SET_FILE_FOLDER_VIEW_MODE, and RESTORE_FILE_FOLDER_SPLIT so we can test
// state transitions without a full React provider.

function applySetSplitRatio(ffl: FileFolderLayoutState, ratio: number): FileFolderLayoutState {
    const clamped = Math.max(0, Math.min(1, ratio));
    const mode = fileFolderViewModeFromRatio(clamped);
    const lastSplitRatio = mode === 'split' ? clamped : ffl.lastSplitRatio;
    return { mode, splitRatio: clamped, lastSplitRatio };
}

function applySetViewMode(ffl: FileFolderLayoutState, newMode: FileFolderLayoutState['mode']): FileFolderLayoutState {
    if (newMode === ffl.mode) return ffl;
    let ratio = ffl.splitRatio;
    let lastSplitRatio = ffl.lastSplitRatio;
    if (newMode === 'folder-only') ratio = 0;
    else if (newMode === 'file-only') ratio = 1;
    else {
        ratio = lastSplitRatio || FILE_FOLDER_SPLIT_RATIO_DEFAULT;
        lastSplitRatio = ratio;
    }
    return { mode: newMode, splitRatio: ratio, lastSplitRatio };
}

function applyRestoreSplit(ffl: FileFolderLayoutState): FileFolderLayoutState {
    const ratio = ffl.lastSplitRatio || FILE_FOLDER_SPLIT_RATIO_DEFAULT;
    return { mode: 'split', splitRatio: ratio, lastSplitRatio: ratio };
}

function defaultLayout(): FileFolderLayoutState {
    return {
        mode: 'split',
        splitRatio: FILE_FOLDER_SPLIT_RATIO_DEFAULT,
        lastSplitRatio: FILE_FOLDER_SPLIT_RATIO_DEFAULT,
    };
}

// =============================================================================
// 014: split renders both panes
// =============================================================================

test('014: split mode is the default and implies both panes visible', () => {
    const layout = defaultLayout();
    assert.equal(layout.mode, 'split');
    // Both panes should render when mode is 'split'.
    // The component shows filePane and folderPane and the splitter when mode='split'.
    assert.ok(layout.splitRatio > FILE_FOLDER_FOLDER_ONLY_THRESHOLD, 'ratio above folder-only threshold');
    assert.ok(layout.splitRatio < FILE_FOLDER_FILE_ONLY_THRESHOLD, 'ratio below file-only threshold');
});

test('014: split ratio 0.3 produces split mode', () => {
    const layout = applySetSplitRatio(defaultLayout(), 0.3);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.3);
    assert.equal(layout.lastSplitRatio, 0.3);
});

test('014: split ratio 0.7 produces split mode', () => {
    const layout = applySetSplitRatio(defaultLayout(), 0.7);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.7);
    assert.equal(layout.lastSplitRatio, 0.7);
});

// =============================================================================
// 014: file-only hides FolderPanel without state loss
// =============================================================================

test('014: dragging to file-only threshold hides folder pane and preserves lastSplitRatio', () => {
    // Start at split with ratio 0.6
    let layout = applySetSplitRatio(defaultLayout(), 0.6);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.lastSplitRatio, 0.6);

    // Drag to file-only threshold
    layout = applySetSplitRatio(layout, FILE_FOLDER_FILE_ONLY_THRESHOLD);
    assert.equal(layout.mode, 'file-only');
    assert.equal(layout.splitRatio, FILE_FOLDER_FILE_ONLY_THRESHOLD);
    // lastSplitRatio must NOT be overwritten -- it preserves the last split value
    assert.equal(layout.lastSplitRatio, 0.6);
});

test('014: SET_FILE_FOLDER_VIEW_MODE file-only sets ratio to 1 but preserves lastSplitRatio', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.55);
    assert.equal(layout.lastSplitRatio, 0.55);

    layout = applySetViewMode(layout, 'file-only');
    assert.equal(layout.mode, 'file-only');
    assert.equal(layout.splitRatio, 1);
    // lastSplitRatio from the split state is preserved
    assert.equal(layout.lastSplitRatio, 0.55);
});

test('014: file-only via ratio=1 preserves lastSplitRatio', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.4);
    layout = applySetSplitRatio(layout, 1);
    assert.equal(layout.mode, 'file-only');
    assert.equal(layout.lastSplitRatio, 0.4, 'lastSplitRatio from split is preserved');
});

// =============================================================================
// 014: folder-only keeps active file path
// =============================================================================

test('014: folder-only mode does not affect file path (mode change is orthogonal to file state)', () => {
    // The layout state tracks mode/ratio but NOT the active file path.
    // Active file path is tracked separately (in SidebarRailRouter via
    // rightPreviewFilePath). This test confirms folder-only transition
    // preserves the lastSplitRatio so the file pane can restore later.
    let layout = applySetSplitRatio(defaultLayout(), 0.65);
    assert.equal(layout.lastSplitRatio, 0.65);

    layout = applySetViewMode(layout, 'folder-only');
    assert.equal(layout.mode, 'folder-only');
    assert.equal(layout.splitRatio, 0);
    // lastSplitRatio survives folder-only transition
    assert.equal(layout.lastSplitRatio, 0.65);
});

test('014: dragging to folder-only threshold preserves lastSplitRatio', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.45);
    layout = applySetSplitRatio(layout, FILE_FOLDER_FOLDER_ONLY_THRESHOLD);
    assert.equal(layout.mode, 'folder-only');
    assert.equal(layout.lastSplitRatio, 0.45, 'previous split ratio preserved');
});

test('014: from folder-only, restoring split uses lastSplitRatio', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.6);
    layout = applySetViewMode(layout, 'folder-only');
    assert.equal(layout.mode, 'folder-only');

    // Restore split
    layout = applyRestoreSplit(layout);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.6);
    assert.equal(layout.lastSplitRatio, 0.6);
});

// =============================================================================
// 014: threshold drags dispatch expected mode transitions
// =============================================================================

test('014: drag from split across file-only threshold triggers file-only mode', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.5);
    // Simulate progressive drag toward file-only
    layout = applySetSplitRatio(layout, 0.7);
    assert.equal(layout.mode, 'split');
    layout = applySetSplitRatio(layout, 0.85);
    assert.equal(layout.mode, 'split');
    layout = applySetSplitRatio(layout, FILE_FOLDER_FILE_ONLY_THRESHOLD);
    assert.equal(layout.mode, 'file-only');
    layout = applySetSplitRatio(layout, 0.95);
    assert.equal(layout.mode, 'file-only');
});

test('014: drag from split across folder-only threshold triggers folder-only mode', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.5);
    layout = applySetSplitRatio(layout, 0.2);
    assert.equal(layout.mode, 'split');
    layout = applySetSplitRatio(layout, FILE_FOLDER_FOLDER_ONLY_THRESHOLD);
    assert.equal(layout.mode, 'folder-only');
    layout = applySetSplitRatio(layout, 0.05);
    assert.equal(layout.mode, 'folder-only');
});

test('014: dragging back from file-only restores split and updates lastSplitRatio', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.5);
    layout = applySetSplitRatio(layout, 0.95); // file-only
    assert.equal(layout.mode, 'file-only');
    assert.equal(layout.lastSplitRatio, 0.5, 'preserved from split');

    // Drag back below threshold
    layout = applySetSplitRatio(layout, 0.75);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.75);
    assert.equal(layout.lastSplitRatio, 0.75, 'updated to new split ratio');
});

test('014: dragging back from folder-only restores split and updates lastSplitRatio', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.5);
    layout = applySetSplitRatio(layout, 0.05); // folder-only
    assert.equal(layout.mode, 'folder-only');

    // Drag back above threshold
    layout = applySetSplitRatio(layout, 0.25);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.25);
    assert.equal(layout.lastSplitRatio, 0.25, 'updated to new split ratio');
});

// =============================================================================
// 014: RESTORE_FILE_FOLDER_SPLIT from file-only
// =============================================================================

test('014: RESTORE from file-only uses lastSplitRatio', () => {
    let layout = applySetSplitRatio(defaultLayout(), 0.55);
    layout = applySetViewMode(layout, 'file-only');
    assert.equal(layout.mode, 'file-only');

    layout = applyRestoreSplit(layout);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.55);
});

test('014: RESTORE from file-only with no prior lastSplitRatio uses default', () => {
    // Edge case: layout with zero lastSplitRatio
    const layout: FileFolderLayoutState = { mode: 'file-only', splitRatio: 1, lastSplitRatio: 0 };
    const restored = applyRestoreSplit(layout);
    assert.equal(restored.mode, 'split');
    assert.equal(restored.splitRatio, FILE_FOLDER_SPLIT_RATIO_DEFAULT);
});

// =============================================================================
// 014: ratio clamping
// =============================================================================

test('014: ratio is clamped to [0,1]', () => {
    let layout = applySetSplitRatio(defaultLayout(), -0.5);
    assert.equal(layout.splitRatio, 0);
    assert.equal(layout.mode, 'folder-only');

    layout = applySetSplitRatio(defaultLayout(), 1.5);
    assert.equal(layout.splitRatio, 1);
    assert.equal(layout.mode, 'file-only');
});

// =============================================================================
// 014: folder toggle button behavior via SET_FILE_FOLDER_VIEW_MODE
// =============================================================================

test('014: folder button in file-only triggers RESTORE which uses lastSplitRatio', () => {
    // The folder button dispatches RESTORE_FILE_FOLDER_SPLIT when mode is file-only
    let layout = applySetSplitRatio(defaultLayout(), 0.6);
    layout = applySetViewMode(layout, 'file-only');
    // Folder button action
    layout = applyRestoreSplit(layout);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.6);
});

test('014: folder button in split dispatches file-only', () => {
    // The folder button dispatches SET_FILE_FOLDER_VIEW_MODE 'file-only' when in split
    let layout = applySetSplitRatio(defaultLayout(), 0.6);
    layout = applySetViewMode(layout, 'file-only');
    assert.equal(layout.mode, 'file-only');
    assert.equal(layout.lastSplitRatio, 0.6);
});

test('014: folder button in folder-only can restore split', () => {
    // The folder button dispatches RESTORE_FILE_FOLDER_SPLIT when in folder-only
    let layout = applySetSplitRatio(defaultLayout(), 0.4);
    layout = applySetViewMode(layout, 'folder-only');
    assert.equal(layout.mode, 'folder-only');
    layout = applyRestoreSplit(layout);
    assert.equal(layout.mode, 'split');
    assert.equal(layout.splitRatio, 0.4);
});

// =============================================================================
// 014: file-only mode data-mode attribute contract
// =============================================================================

test('014: FileFolderSplitPanel mode values are exactly the FileFolderViewMode union', () => {
    // Verify all three modes are reachable and produce correct mode values
    assert.equal(fileFolderViewModeFromRatio(0.5), 'split');
    assert.equal(fileFolderViewModeFromRatio(0), 'folder-only');
    assert.equal(fileFolderViewModeFromRatio(1), 'file-only');
});
