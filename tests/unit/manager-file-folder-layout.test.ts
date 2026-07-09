import test from 'node:test';
import assert from 'node:assert/strict';
import {
    focusOrCreateFirstRightSidebarTab,
    createRightSidebarTab,
    activateRightSidebarTab,
    closeRightSidebarTab,
    updateRightSidebarTabMeta,
    openFileInFilesTab,
    openFolderInFilesTab,
    resolveTargetFilesTab,
    fileFolderViewModeFromRatio,
} from '../../public/manager/src/panels/PanelLayoutProvider.js';
import {
    panelLayoutInitialStateFromUi,
    panelLayoutUiFromState,
} from '../../public/manager/src/panels/panel-layout-registry-state.js';
import type { RightSidebarTabsState } from '../../public/manager/src/panels/types.js';
import type { DashboardRegistryUi } from '../../public/manager/src/types.js';
import {
    FILE_FOLDER_FOLDER_ONLY_THRESHOLD,
    FILE_FOLDER_FILE_ONLY_THRESHOLD,
    FILE_FOLDER_SPLIT_RATIO_DEFAULT,
} from '../../public/manager/src/panels/types.js';

// ---- Helper to build a minimal DashboardRegistryUi for testing ----

function makeUi(overrides: Partial<DashboardRegistryUi> = {}): DashboardRegistryUi {
    return {
        selectedPort: null,
        selectedTab: 'overview',
        sidebarCollapsed: false,
        activityDockCollapsed: true,
        activityDockHeight: 200,
        activitySeenAt: null,
        activitySeenByPort: {},
        uiTheme: 'auto',
        locale: 'en',
        sidebarMode: 'instances',
        notesSelectedPath: null,
        notesViewMode: 'edit',
        notesAuthoringMode: 'raw',
        notesWordWrap: false,
        notesVimMode: false,
        notesTreeWidth: 240,
        notesGraphSettings: { layout: 'force', showOrphans: true, linkStrength: 0.5 },
        showLatestActivityTitles: false,
        showInlineLabelEditor: false,
        showSidebarRuntimeLine: false,
        showSelectedRowActions: false,
        dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: 'default',
        diffRootPolicy: 'instance',
        diffPinnedRootByPort: {},
        diffRecentRepoRoots: [],
        diffDefaultMode: 'unified',
        diffBaseRef: 'HEAD',
        diffIncludeUntracked: false,
        rightFolderRootPath: null,
        ...overrides,
    } as DashboardRegistryUi;
}

function emptyTabs(): RightSidebarTabsState {
    return { openTabs: [], activeTabId: null, nextOrdinalByKind: {} };
}

// =============================================================================
// File/Folder layout: ratio clamping and threshold transitions
// =============================================================================

test('fileFolderViewModeFromRatio returns folder-only at threshold', () => {
    assert.equal(fileFolderViewModeFromRatio(FILE_FOLDER_FOLDER_ONLY_THRESHOLD), 'folder-only');
    assert.equal(fileFolderViewModeFromRatio(0), 'folder-only');
    assert.equal(fileFolderViewModeFromRatio(0.05), 'folder-only');
});

test('fileFolderViewModeFromRatio returns file-only at threshold', () => {
    assert.equal(fileFolderViewModeFromRatio(FILE_FOLDER_FILE_ONLY_THRESHOLD), 'file-only');
    assert.equal(fileFolderViewModeFromRatio(1), 'file-only');
    assert.equal(fileFolderViewModeFromRatio(0.95), 'file-only');
});

test('fileFolderViewModeFromRatio returns split between thresholds', () => {
    assert.equal(fileFolderViewModeFromRatio(0.5), 'split');
    assert.equal(fileFolderViewModeFromRatio(0.13), 'split');
    assert.equal(fileFolderViewModeFromRatio(0.87), 'split');
});

test('threshold boundary transitions are stable', () => {
    // Just above folder-only threshold -> split
    assert.equal(fileFolderViewModeFromRatio(FILE_FOLDER_FOLDER_ONLY_THRESHOLD + 0.01), 'split');
    // Just below file-only threshold -> split
    assert.equal(fileFolderViewModeFromRatio(FILE_FOLDER_FILE_ONLY_THRESHOLD - 0.01), 'split');
});

// =============================================================================
// Launcher semantics: focusOrCreateFirstRightSidebarTab
// =============================================================================

test('focusOrCreateFirstRightSidebarTab creates the first tab of a kind', () => {
    const result = focusOrCreateFirstRightSidebarTab(emptyTabs(), 'files');
    assert.equal(result.openTabs.length, 1);
    assert.equal(result.openTabs[0].kind, 'files');
    assert.equal(result.openTabs[0].id, 'right-files-1');
    assert.equal(result.openTabs[0].specificName, 'Files 1');
    assert.equal(result.activeTabId, 'right-files-1');
});

test('focusOrCreateFirstRightSidebarTab focuses the first existing tab instead of duplicating', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    assert.equal(tabs.openTabs.length, 3);
    const result = focusOrCreateFirstRightSidebarTab(tabs, 'files');
    assert.equal(result.openTabs.length, 3);
    assert.equal(result.activeTabId, 'right-files-1');
});

test('focusOrCreateFirstRightSidebarTab creates each missing kind', () => {
    let tabs = emptyTabs();
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'files');
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'diff');
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'browser');
    assert.deepEqual(tabs.openTabs.map(t => t.kind), ['files', 'diff', 'browser']);
});

// =============================================================================
// '+' semantics: createRightSidebarTab (multi-instance + Diff singleton)
// =============================================================================

test('createRightSidebarTab creates Files 1, Files 2, Files 3 with ordinals', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'files');
    assert.deepEqual(tabs.openTabs.map(t => t.id), ['right-files-1', 'right-files-2', 'right-files-3']);
    assert.deepEqual(tabs.openTabs.map(t => t.specificName), ['Files 1', 'Files 2', 'Files 3']);
    assert.deepEqual(tabs.openTabs.map(t => t.ordinal), [1, 2, 3]);
    assert.equal(tabs.nextOrdinalByKind.files, 4);
    assert.equal(tabs.activeTabId, 'right-files-3');
});

test('createRightSidebarTab creates Browser 1, Browser 2', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'browser');
    tabs = createRightSidebarTab(tabs, 'browser');
    assert.deepEqual(tabs.openTabs.map(t => t.id), ['right-browser-1', 'right-browser-2']);
    assert.deepEqual(tabs.openTabs.map(t => t.specificName), ['Browser 1', 'Browser 2']);
    assert.equal(tabs.nextOrdinalByKind.browser, 3);
});

test('createRightSidebarTab keeps Diff singleton: second create focuses the existing tab', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'diff');
    assert.equal(tabs.openTabs[0].id, 'right-diff');
    assert.equal(tabs.openTabs[0].specificName, 'Working tree');
    tabs = createRightSidebarTab(tabs, 'files');
    assert.equal(tabs.activeTabId, 'right-files-1');
    const result = createRightSidebarTab(tabs, 'diff');
    assert.equal(result.openTabs.filter(t => t.kind === 'diff').length, 1);
    assert.equal(result.activeTabId, 'right-diff');
    // Diff never allocates an ordinal
    assert.equal(result.nextOrdinalByKind.diff, undefined);
});

test('ordinals are not reused after closing a tab', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files'); // Files 1
    tabs = closeRightSidebarTab(tabs, 'right-files-1');
    tabs = createRightSidebarTab(tabs, 'files');
    assert.equal(tabs.openTabs[0].id, 'right-files-2');
    assert.equal(tabs.openTabs[0].specificName, 'Files 2');
});

// =============================================================================
// activateRightSidebarTab / updateRightSidebarTabMeta
// =============================================================================

test('activateRightSidebarTab activates an existing tab', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    const result = activateRightSidebarTab(tabs, 'right-files-1');
    assert.equal(result.activeTabId, 'right-files-1');
});

test('activateRightSidebarTab is no-op for unknown id', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'files');
    const result = activateRightSidebarTab(tabs, 'nonexistent');
    assert.equal(result.activeTabId, tabs.activeTabId);
    assert.equal(result.openTabs.length, 1);
});

test('updateRightSidebarTabMeta changes name without changing order or active tab', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    tabs = createRightSidebarTab(tabs, 'browser');
    tabs = activateRightSidebarTab(tabs, 'right-browser-1');
    const result = updateRightSidebarTabMeta(tabs, 'right-files-1', { specificName: 'README.md', sourceLabel: '/home/u/README.md' });
    assert.deepEqual(result.openTabs.map(t => t.id), ['right-files-1', 'right-browser-1']);
    assert.equal(result.activeTabId, 'right-browser-1');
    assert.equal(result.openTabs[0].specificName, 'README.md');
    assert.equal(result.openTabs[0].sourceLabel, '/home/u/README.md');
});

// =============================================================================
// closeRightSidebarTab
// =============================================================================

test('closing inactive tab keeps active tab', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    tabs = createRightSidebarTab(tabs, 'browser');
    const result = closeRightSidebarTab(tabs, 'right-files-1');
    assert.equal(result.openTabs.length, 2);
    assert.equal(result.activeTabId, tabs.activeTabId); // browser still active
});

test('closing active tab activates nearest left', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    tabs = createRightSidebarTab(tabs, 'browser');
    tabs = activateRightSidebarTab(tabs, 'right-diff');
    const result = closeRightSidebarTab(tabs, 'right-diff');
    assert.equal(result.openTabs.length, 2);
    assert.equal(result.activeTabId, 'right-files-1');
});

test('closing active tab activates nearest right when no left neighbor', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    tabs = activateRightSidebarTab(tabs, 'right-files-1');
    const result = closeRightSidebarTab(tabs, 'right-files-1');
    assert.equal(result.openTabs.length, 1);
    assert.equal(result.activeTabId, 'right-diff');
});

test('closing the last tab leaves activeTabId null', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    const result = closeRightSidebarTab(tabs, 'right-files-1');
    assert.equal(result.openTabs.length, 0);
    assert.equal(result.activeTabId, null);
});

test('closing a non-existent tab is a no-op', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'files');
    const result = closeRightSidebarTab(tabs, 'nonexistent');
    assert.deepEqual(result, tabs);
});

// =============================================================================
// Files per-tab resource state (020 §5)
// =============================================================================

test('openFileInFilesTab creates a Files tab and assigns the file with name/sourceLabel', () => {
    const result = openFileInFilesTab(emptyTabs(), '/home/u/devlog/plan.md');
    assert.equal(result.openTabs.length, 1);
    const tab = result.openTabs[0];
    assert.equal(tab.kind, 'files');
    assert.equal(tab.files?.activeFilePath, '/home/u/devlog/plan.md');
    assert.equal(tab.specificName, 'plan.md');
    assert.equal(tab.sourceLabel, '/home/u/devlog/plan.md');
    assert.equal(result.activeTabId, tab.id);
});

test('openFileInFilesTab targets the active Files tab when active tab is files', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    tabs = createRightSidebarTab(tabs, 'files'); // right-files-2 active
    const result = openFileInFilesTab(tabs, '/home/u/a.md');
    assert.equal(result.openTabs.length, 2);
    assert.equal(result.openTabs[1].files?.activeFilePath, '/home/u/a.md');
    assert.equal(result.openTabs[1].specificName, 'a.md');
    assert.equal(result.openTabs[0].files?.activeFilePath, undefined);
});

test('openFileInFilesTab targets the first Files tab when active tab is another kind', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    tabs = createRightSidebarTab(tabs, 'diff'); // diff active
    const result = openFileInFilesTab(tabs, '/home/u/b.md');
    assert.equal(result.activeTabId, 'right-files-1');
    assert.equal(result.openTabs[0].files?.activeFilePath, '/home/u/b.md');
});

test('opening a second file in the same Files tab replaces the active file', () => {
    let tabs = openFileInFilesTab(emptyTabs(), '/home/u/a.md');
    tabs = openFileInFilesTab(tabs, '/home/u/b.md');
    assert.equal(tabs.openTabs.length, 1);
    assert.equal(tabs.openTabs[0].files?.activeFilePath, '/home/u/b.md');
    assert.equal(tabs.openTabs[0].specificName, 'b.md');
});

test('openFolderInFilesTab assigns the root and names the tab from the root basename', () => {
    const result = openFolderInFilesTab(emptyTabs(), '/home/u/project');
    assert.equal(result.openTabs.length, 1);
    assert.equal(result.openTabs[0].files?.folderRootPath, '/home/u/project');
    assert.equal(result.openTabs[0].specificName, 'project');
});

test('openFolderInFilesTab keeps the active-file name when a file is open', () => {
    let tabs = openFileInFilesTab(emptyTabs(), '/home/u/a.md');
    tabs = openFolderInFilesTab(tabs, '/home/u/project');
    assert.equal(tabs.openTabs[0].specificName, 'a.md');
    assert.equal(tabs.openTabs[0].files?.folderRootPath, '/home/u/project');
});

test('resolveTargetFilesTab prefers the active files tab, else the first files tab', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    tabs = createRightSidebarTab(tabs, 'files');
    assert.equal(resolveTargetFilesTab(tabs)?.id, 'right-files-2');
    tabs = createRightSidebarTab(tabs, 'diff');
    assert.equal(resolveTargetFilesTab(tabs)?.id, 'right-files-1');
    assert.equal(resolveTargetFilesTab(emptyTabs()), null);
});

// =============================================================================
// Registry persistence round-trip
// =============================================================================

test('panelLayoutUiFromState and panelLayoutInitialStateFromUi round-trip', () => {
    let tabs = emptyTabs();
    tabs = openFileInFilesTab(tabs, '/home/u/devlog/plan.md');
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    tabs = activateRightSidebarTab(tabs, 'right-files-1');

    const state = {
        rightPanel: {
            open: true,
            width: 400,
            tabs,
            fileFolderLayout: { mode: 'split' as const, splitRatio: 0.6, lastSplitRatio: 0.6 },
        },
        bottomPanel: {
            open: false,
            height: 320,
            tabs: [],
            activeTab: null,
        },
    };

    const ui = panelLayoutUiFromState(state);
    const restored = panelLayoutInitialStateFromUi(makeUi(ui));

    assert.equal(restored.rightPanel!.open, true);
    assert.equal(restored.rightPanel!.width, 400);
    assert.equal(restored.rightPanel!.tabs.openTabs.length, 3);
    assert.deepEqual(restored.rightPanel!.tabs.openTabs.map(t => t.id), ['right-files-1', 'right-files-2', 'right-diff']);
    assert.equal(restored.rightPanel!.tabs.activeTabId, 'right-files-1');
    // specificName / sourceLabel / ordinal survive
    assert.equal(restored.rightPanel!.tabs.openTabs[0].specificName, 'plan.md');
    assert.equal(restored.rightPanel!.tabs.openTabs[0].sourceLabel, '/home/u/devlog/plan.md');
    assert.equal(restored.rightPanel!.tabs.openTabs[1].ordinal, 2);
    // per-tab files state survives
    assert.equal(restored.rightPanel!.tabs.openTabs[0].files?.activeFilePath, '/home/u/devlog/plan.md');
    // nextOrdinalByKind survives
    assert.equal(restored.rightPanel!.tabs.nextOrdinalByKind.files, 3);
    assert.equal(restored.rightPanel!.fileFolderLayout.mode, 'split');
    assert.equal(restored.rightPanel!.fileFolderLayout.splitRatio, 0.6);
    assert.equal(restored.rightPanel!.fileFolderLayout.lastSplitRatio, 0.6);
});

test('round-trip preserves file-only mode and ratio', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'files');
    const state = {
        rightPanel: {
            open: true,
            width: 480,
            tabs,
            fileFolderLayout: { mode: 'file-only' as const, splitRatio: 1, lastSplitRatio: 0.55 },
        },
        bottomPanel: { open: false, height: 320, tabs: [] as string[], activeTab: null },
    };
    const ui = panelLayoutUiFromState(state);
    const restored = panelLayoutInitialStateFromUi(makeUi(ui));
    assert.equal(restored.rightPanel!.fileFolderLayout.mode, 'file-only');
    assert.equal(restored.rightPanel!.fileFolderLayout.splitRatio, 1);
    assert.equal(restored.rightPanel!.fileFolderLayout.lastSplitRatio, 0.55);
});

test('legacy singleton tab ids hydrate without crashing and stay readable', () => {
    const ui = makeUi({
        panelLayoutVersion: 2,
        rightPanelOpen: true,
        rightSidebarOpenTabs: [
            { id: 'right-files', kind: 'files', title: 'Files' },
            { id: 'right-browser', kind: 'browser', title: 'Browser' },
        ],
        rightSidebarActiveTabId: 'right-files',
    });
    const restored = panelLayoutInitialStateFromUi(ui);
    assert.equal(restored.rightPanel!.tabs.openTabs.length, 2);
    assert.equal(restored.rightPanel!.tabs.openTabs[0].id, 'right-files');
    // Missing specificName is filled with the kind default
    assert.equal(restored.rightPanel!.tabs.openTabs[0].specificName, 'Files 1');
    assert.equal(restored.rightPanel!.tabs.activeTabId, 'right-files');
});

test('hydration enforces one Diff tab max', () => {
    const ui = makeUi({
        panelLayoutVersion: 2,
        rightSidebarOpenTabs: [
            { id: 'right-diff', kind: 'diff', title: 'Diff' },
            { id: 'right-diff-dup', kind: 'diff', title: 'Diff' },
        ],
    });
    const restored = panelLayoutInitialStateFromUi(ui);
    assert.equal(restored.rightPanel!.tabs.openTabs.filter(t => t.kind === 'diff').length, 1);
});

test('hydration infers ordinal from id suffix and computes nextOrdinalByKind', () => {
    const ui = makeUi({
        panelLayoutVersion: 2,
        rightSidebarOpenTabs: [
            { id: 'right-files-3', kind: 'files', title: 'Files', specificName: 'notes.md' },
        ],
    });
    const restored = panelLayoutInitialStateFromUi(ui);
    assert.equal(restored.rightPanel!.tabs.openTabs[0].ordinal, 3);
    assert.equal(restored.rightPanel!.tabs.nextOrdinalByKind.files, 4);
});

// =============================================================================
// Legacy hydration migration (topMode/bottomMode)
// =============================================================================

test('legacy folder top mode hydrates to Files tab', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'folder',
        rightPanelBottomMode: null,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    assert.equal(result.rightPanel!.tabs.openTabs.length, 1);
    assert.equal(result.rightPanel!.tabs.openTabs[0].kind, 'files');
    assert.equal(result.rightPanel!.tabs.activeTabId, result.rightPanel!.tabs.openTabs[0].id);
});

test('legacy doc top mode hydrates to Files tab', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'doc',
        rightPanelBottomMode: null,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    assert.equal(result.rightPanel!.tabs.openTabs.length, 1);
    assert.equal(result.rightPanel!.tabs.openTabs[0].kind, 'files');
});

test('legacy folder+doc split hydrates into single Files tab', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'folder',
        rightPanelBottomMode: 'doc',
        rightPanelSplitRatio: 0.5,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    // folder and doc both map to files -> should be deduplicated to one tab
    assert.equal(result.rightPanel!.tabs.openTabs.length, 1);
    assert.equal(result.rightPanel!.tabs.openTabs[0].kind, 'files');
});

test('legacy diff top mode hydrates to Diff tab', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'diff',
        rightPanelBottomMode: null,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    assert.equal(result.rightPanel!.tabs.openTabs.length, 1);
    assert.equal(result.rightPanel!.tabs.openTabs[0].kind, 'diff');
    assert.equal(result.rightPanel!.tabs.openTabs[0].specificName, 'Working tree');
});

test('legacy browser top mode hydrates to Browser tab', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'browser',
        rightPanelBottomMode: null,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    assert.equal(result.rightPanel!.tabs.openTabs.length, 1);
    assert.equal(result.rightPanel!.tabs.openTabs[0].kind, 'browser');
});

test('legacy ceo top mode hydrates to Files tab (CEO hidden)', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'ceo',
        rightPanelBottomMode: null,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    assert.equal(result.rightPanel!.tabs.openTabs.length, 1);
    assert.equal(result.rightPanel!.tabs.openTabs[0].kind, 'files');
});

test('legacy folder+diff split hydrates to Files+Diff tabs', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'folder',
        rightPanelBottomMode: 'diff',
        rightPanelSplitRatio: 0.6,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    assert.equal(result.rightPanel!.tabs.openTabs.length, 2);
    assert.equal(result.rightPanel!.tabs.openTabs[0].kind, 'files');
    assert.equal(result.rightPanel!.tabs.openTabs[1].kind, 'diff');
    // Active tab is the first (top mode)
    assert.equal(result.rightPanel!.tabs.activeTabId, result.rightPanel!.tabs.openTabs[0].id);
});

test('legacy vertical splitRatio is dropped (not carried to fileFolderLayout)', () => {
    const ui = makeUi({
        panelLayoutVersion: 1,
        rightPanelOpen: true,
        rightPanelTopMode: 'folder',
        rightPanelBottomMode: null,
        rightPanelSplitRatio: 0.7,
    });
    const result = panelLayoutInitialStateFromUi(ui);
    // fileFolderLayout should use default, not the old vertical splitRatio
    assert.equal(result.rightPanel!.fileFolderLayout.splitRatio, FILE_FOLDER_SPLIT_RATIO_DEFAULT);
    assert.equal(result.rightPanel!.fileFolderLayout.mode, 'split');
});

test('no panelLayoutVersion returns empty state', () => {
    const ui = makeUi({});
    const result = panelLayoutInitialStateFromUi(ui);
    assert.deepEqual(result, {});
});

// =============================================================================
// Removed actions and fields are gone
// =============================================================================

test('RightPanelMode no longer includes doc', async () => {
    const { RIGHT_PANEL_MODES } = await import('../../public/manager/src/panels/types.js');
    assert.ok(!RIGHT_PANEL_MODES.includes('doc'), 'doc should not be in RIGHT_PANEL_MODES');
});

test('panelLayoutUiFromState clears legacy fields and stops writing lastActiveByKind', () => {
    const state = {
        rightPanel: {
            open: true,
            width: 480,
            tabs: createRightSidebarTab(emptyTabs(), 'files'),
            fileFolderLayout: { mode: 'split' as const, splitRatio: 0.5, lastSplitRatio: 0.5 },
        },
        bottomPanel: { open: false, height: 320, tabs: [] as string[], activeTab: null },
    };
    const ui = panelLayoutUiFromState(state);
    assert.equal(ui.rightPanelTopMode, undefined);
    assert.equal(ui.rightPanelBottomMode, undefined);
    assert.equal(ui.rightPanelSplitRatio, undefined);
    assert.equal(ui.rightSidebarLastActiveByKind, undefined);
    assert.deepEqual(ui.rightSidebarNextOrdinalByKind, { files: 2 });
    assert.equal(ui.panelLayoutVersion, 2);
});

test('new tabs state shape has nextOrdinalByKind, not lastActiveByKind', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'files') as unknown as Record<string, unknown>;
    assert.equal('lastActiveByKind' in tabs, false);
    assert.ok('nextOrdinalByKind' in tabs);
});
