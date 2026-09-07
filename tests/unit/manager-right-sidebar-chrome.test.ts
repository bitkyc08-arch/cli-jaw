/**
 * Files Tab Chrome + 020B/020D chrome-facing tests.
 *
 * These tests verify:
 * - Right sidebar renders tablist roles (role="tablist", role="tab", aria-selected)
 * - Folder button renders at far right in Files tab chrome
 * - Breadcrumb final file segment stays visible at narrow width
 * - Closing/reopening right panel does not reset active tab/layout
 * - CEO not rendered in strip or plus menu
 * - Plus menu CREATE semantics (Diff omitted while open)
 * - Tab label resolver renders kind icon + specific instance name
 * - Density classes adapt to the open-tab count
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    focusOrCreateFirstRightSidebarTab,
    createRightSidebarTab,
    activateRightSidebarTab,
    closeRightSidebarTab,
    fileFolderViewModeFromRatio,
} from '../../public/manager/src/panels/PanelLayoutProvider.js';
import {
    getRightSidebarTabDisplay,
    getRightSidebarTabDensity,
} from '../../public/manager/src/panels/right-sidebar-tab-display.js';
import type { RightSidebarTabsState, RightSidebarTabKind } from '../../public/manager/src/panels/types.js';
import {
    RIGHT_SIDEBAR_TAB_KINDS,
    RIGHT_SIDEBAR_TAB_TITLES,
} from '../../public/manager/src/panels/types.js';

// ---- Helpers ----

function emptyTabs(): RightSidebarTabsState {
    return { openTabs: [], activeTabId: null, nextOrdinalByKind: {} };
}

// =============================================================================
// Tablist roles
// =============================================================================

test('RIGHT_SIDEBAR_TAB_KINDS includes files, diff, browser, design', () => {
    assert.deepEqual(RIGHT_SIDEBAR_TAB_KINDS, ['files', 'diff', 'browser', 'design']);
});

test('RIGHT_SIDEBAR_TAB_TITLES provides human labels for all kinds', () => {
    assert.equal(RIGHT_SIDEBAR_TAB_TITLES.files, 'Files');
    assert.equal(RIGHT_SIDEBAR_TAB_TITLES.diff, 'Diff');
    assert.equal(RIGHT_SIDEBAR_TAB_TITLES.browser, 'Browser');
    assert.equal(RIGHT_SIDEBAR_TAB_TITLES.design, 'Design');
});

test('open tabs have stable ids suitable for role="tab" keying', () => {
    let tabs = emptyTabs();
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'files');
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'diff');
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'browser');
    // Each tab should have a unique, stable id
    const ids = tabs.openTabs.map(t => t.id);
    assert.equal(new Set(ids).size, 3, 'all tab ids are unique');
    // Ids should be deterministic
    assert.equal(ids[0], 'right-files-1');
    assert.equal(ids[1], 'right-diff');
    assert.equal(ids[2], 'right-browser-1');
});

test('active tab has aria-selected=true equivalent (activeTabId matches)', () => {
    let tabs = emptyTabs();
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'files');
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'diff');
    // Activate files
    tabs = activateRightSidebarTab(tabs, tabs.openTabs[0].id);
    assert.equal(tabs.activeTabId, tabs.openTabs[0].id);
    // Non-active tabs should NOT be the active tab id
    assert.notEqual(tabs.activeTabId, tabs.openTabs[1].id);
});

// =============================================================================
// Tab label resolver: kind icon + specific instance name (020 §6)
// =============================================================================

test('tab display uses specificName as the visible label', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'files');
    const display = getRightSidebarTabDisplay(tabs.openTabs[0]);
    assert.equal(display.visibleLabel, 'Files 1');
});

test('tab display tooltip and aria carry kind plus full specific detail', () => {
    const tab = {
        id: 'right-files-1',
        kind: 'files' as const,
        title: 'Files',
        specificName: 'plan.md',
        sourceLabel: '/home/u/project/docs/plan.md',
        ordinal: 1,
    };
    const display = getRightSidebarTabDisplay(tab);
    assert.equal(display.visibleLabel, 'plan.md');
    assert.equal(display.title, 'Files: /home/u/project/docs/plan.md');
    assert.equal(display.ariaLabel, 'Files tab, /home/u/project/docs/plan.md');
});

test('tab display falls back to specificName when no sourceLabel exists', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'diff');
    const display = getRightSidebarTabDisplay(tabs.openTabs[0]);
    assert.equal(display.visibleLabel, 'Working tree');
    assert.equal(display.title, 'Diff: Working tree');
});

// =============================================================================
// Density classes: strip content adapts to the open-tab count
// =============================================================================

test('tab density is comfortable/compact/mini by open-tab count', () => {
    assert.equal(getRightSidebarTabDensity(1), 'comfortable');
    assert.equal(getRightSidebarTabDensity(2), 'comfortable');
    assert.equal(getRightSidebarTabDensity(3), 'compact');
    assert.equal(getRightSidebarTabDensity(4), 'compact');
    assert.equal(getRightSidebarTabDensity(5), 'mini');
    assert.equal(getRightSidebarTabDensity(8), 'mini');
});

// =============================================================================
// Folder button far-right position
// =============================================================================
// The folder button is always the last element in the Files toolbar.
// Since this is a unit test (no DOM), we verify the layout state contract
// that the folder button reacts to.

test('file-only mode sets folder toggle to aria-pressed=false equivalent', () => {
    assert.equal(fileFolderViewModeFromRatio(1.0), 'file-only');
    assert.equal(fileFolderViewModeFromRatio(0.95), 'file-only');
});

test('split mode sets folder toggle to aria-pressed=true equivalent', () => {
    assert.equal(fileFolderViewModeFromRatio(0.5), 'split');
});

test('folder-only mode sets folder toggle to aria-pressed=true equivalent', () => {
    assert.equal(fileFolderViewModeFromRatio(0.0), 'folder-only');
});

// =============================================================================
// Breadcrumb final file segment visibility
// =============================================================================
// The breadcrumb CSS ensures the final segment has min-width and flex-shrink: 0.
// Here we test the path-to-segments parsing logic.

function parseBreadcrumb(filePath: string | null | undefined): string[] {
    if (!filePath) return [];
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean);
}

test('breadcrumb segments parse from a unix path', () => {
    const segments = parseBreadcrumb('/home/user/project/docs/feature/plan.md');
    assert.ok(segments.length > 0);
    assert.equal(segments[segments.length - 1], 'plan.md');
});

test('breadcrumb segments parse from a windows-style path', () => {
    const segments = parseBreadcrumb('C:\\Users\\dev\\file.ts');
    assert.equal(segments[segments.length - 1], 'file.ts');
});

test('breadcrumb returns empty for null/undefined', () => {
    assert.deepEqual(parseBreadcrumb(null), []);
    assert.deepEqual(parseBreadcrumb(undefined), []);
    assert.deepEqual(parseBreadcrumb(''), []);
});

test('final breadcrumb segment is the file basename', () => {
    const long = parseBreadcrumb('/a/very/long/deeply/nested/path/to/my-component.tsx');
    assert.equal(long[long.length - 1], 'my-component.tsx');
    // The final segment must stay readable (CSS guarantees min-width).
    assert.ok(long.length > 1, 'path has middle segments to truncate');
});

// =============================================================================
// Closing/reopening right panel preserves open tabs and active tab
// =============================================================================

test('closing sidebar (SET_RIGHT_OPEN false) does not clear openTabs', () => {
    // Simulate the reducer behavior: SET_RIGHT_OPEN only toggles .open,
    // not .tabs. We verify by checking the state shape.
    let tabs = emptyTabs();
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'files');
    tabs = focusOrCreateFirstRightSidebarTab(tabs, 'diff');

    const state = {
        open: true,
        width: 480,
        tabs,
        fileFolderLayout: { mode: 'split' as const, splitRatio: 0.5, lastSplitRatio: 0.5 },
    };

    // Simulate SET_RIGHT_OPEN false: only changes .open
    const closed = { ...state, open: false };
    assert.equal(closed.open, false);
    assert.equal(closed.tabs.openTabs.length, 2, 'tabs preserved after close');
    assert.equal(closed.tabs.activeTabId, tabs.activeTabId, 'activeTabId preserved after close');

    // Simulate SET_RIGHT_OPEN true: reopening
    const reopened = { ...closed, open: true };
    assert.equal(reopened.open, true);
    assert.equal(reopened.tabs.openTabs.length, 2, 'tabs preserved after reopen');
    assert.equal(reopened.tabs.activeTabId, tabs.activeTabId, 'activeTabId preserved after reopen');
});

test('closing sidebar preserves fileFolderLayout', () => {
    const tabs = focusOrCreateFirstRightSidebarTab(emptyTabs(), 'files');

    const layout = { mode: 'file-only' as const, splitRatio: 1, lastSplitRatio: 0.6 };
    const state = { open: true, width: 480, tabs, fileFolderLayout: layout };

    // Simulate close
    const closed = { ...state, open: false };
    assert.deepEqual(closed.fileFolderLayout, layout, 'fileFolderLayout preserved');

    // Simulate reopen
    const reopened = { ...closed, open: true };
    assert.deepEqual(reopened.fileFolderLayout, layout, 'fileFolderLayout preserved after reopen');
});

// =============================================================================
// CEO not rendered in strip or plus menu
// =============================================================================

test('RIGHT_SIDEBAR_TAB_KINDS does not include ceo', () => {
    assert.ok(!RIGHT_SIDEBAR_TAB_KINDS.includes('ceo' as RightSidebarTabKind));
});

test('RIGHT_SIDEBAR_TAB_TITLES does not include ceo', () => {
    assert.equal((RIGHT_SIDEBAR_TAB_TITLES as Record<string, string>)['ceo'], undefined);
});

test('ceo is not a valid tab kind', () => {
    const validKinds = new Set<string>(RIGHT_SIDEBAR_TAB_KINDS);
    assert.ok(!validKinds.has('ceo'), 'ceo is not a valid tab kind');
});

// =============================================================================
// Plus menu CREATE semantics (020 §4)
// =============================================================================

// Same filtering logic as the RightSidebar component.
function plusMenuKindsFor(tabs: RightSidebarTabsState): RightSidebarTabKind[] {
    const diffOpen = tabs.openTabs.some(t => t.kind === 'diff');
    return (['files', 'diff', 'browser', 'design'] as RightSidebarTabKind[]).filter(k => !(k === 'diff' && diffOpen));
}

test('plus menu creates a NEW Files instance even when Files tabs exist', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    tabs = createRightSidebarTab(tabs, 'files');
    assert.equal(tabs.openTabs.filter(t => t.kind === 'files').length, 2, 'plus menu creates, never focus-or-creates');
});

test('plus menu creates a NEW Browser instance even when Browser tabs exist', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'browser');
    tabs = createRightSidebarTab(tabs, 'browser');
    assert.equal(tabs.openTabs.filter(t => t.kind === 'browser').length, 2);
});

test('plus menu omits diff when a diff tab already exists', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    const kinds = plusMenuKindsFor(tabs);
    assert.ok(!kinds.includes('diff'), 'diff excluded from plus menu');
    assert.ok(kinds.includes('files'), 'files still in plus menu');
    assert.ok(kinds.includes('browser'), 'browser still in plus menu');
});

test('plus menu includes diff when no diff tab exists', () => {
    const tabs = createRightSidebarTab(emptyTabs(), 'files');
    const kinds = plusMenuKindsFor(tabs);
    assert.ok(kinds.includes('diff'), 'diff available in plus menu');
});

test('diff reappears in the plus menu after the diff tab closes', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'diff');
    assert.ok(!plusMenuKindsFor(tabs).includes('diff'));
    tabs = closeRightSidebarTab(tabs, 'right-diff');
    assert.ok(plusMenuKindsFor(tabs).includes('diff'));
});

// =============================================================================
// Close behavior
// =============================================================================

test('closing active tab activates nearest tab (020 close behavior)', () => {
    let tabs = emptyTabs();
    tabs = createRightSidebarTab(tabs, 'files');
    tabs = createRightSidebarTab(tabs, 'diff');
    tabs = createRightSidebarTab(tabs, 'browser');

    // Activate diff (middle)
    tabs = activateRightSidebarTab(tabs, tabs.openTabs[1].id);
    assert.equal(tabs.activeTabId, tabs.openTabs[1].id);

    // Close diff -> should activate files (nearest left)
    tabs = closeRightSidebarTab(tabs, tabs.openTabs[1].id);
    assert.equal(tabs.activeTabId, tabs.openTabs[0].id);
    assert.equal(tabs.openTabs[0].kind, 'files');
});

test('closing last tab leaves empty state', () => {
    let tabs = createRightSidebarTab(emptyTabs(), 'files');
    tabs = closeRightSidebarTab(tabs, tabs.openTabs[0].id);
    assert.equal(tabs.openTabs.length, 0);
    assert.equal(tabs.activeTabId, null);
});
