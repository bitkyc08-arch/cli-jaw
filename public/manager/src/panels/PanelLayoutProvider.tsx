import { createContext, useContext, useReducer, useCallback, useMemo, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { panelShortcutBus } from './panel-shortcut-bus';
import type { BottomPanelTab, RightSidebarTabKind, RightSidebarOpenTab, RightSidebarTabsState, RightSidebarFilesTabState, RightSidebarDesignTabState, FileFolderLayoutState, FileFolderViewMode } from './types';
import {
    RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH,
    BOTTOM_PANEL_DEFAULT_HEIGHT, BOTTOM_PANEL_MIN_HEIGHT, BOTTOM_PANEL_MAX_HEIGHT,
    BOTTOM_PANEL_TABS,
    RIGHT_SIDEBAR_TAB_KINDS, RIGHT_SIDEBAR_TAB_TITLES,
    RIGHT_SIDEBAR_MULTI_INSTANCE_KINDS, RIGHT_SIDEBAR_DIFF_DEFAULT_NAME,
    FILE_FOLDER_SPLIT_RATIO_DEFAULT,
    FILE_FOLDER_FOLDER_ONLY_THRESHOLD,
    FILE_FOLDER_FILE_ONLY_THRESHOLD,
} from './types';

// --- Right sidebar tab helpers (020A) ---

function isMultiInstanceKind(kind: RightSidebarTabKind): boolean {
    return RIGHT_SIDEBAR_MULTI_INSTANCE_KINDS.includes(kind);
}

function makeTabId(kind: RightSidebarTabKind, ordinal?: number): string {
    return kind === 'diff' ? 'right-diff' : `right-${kind}-${ordinal ?? 1}`;
}

function defaultSpecificName(kind: RightSidebarTabKind, ordinal?: number): string {
    if (kind === 'diff') return RIGHT_SIDEBAR_DIFF_DEFAULT_NAME;
    return `${RIGHT_SIDEBAR_TAB_TITLES[kind]} ${ordinal ?? 1}`;
}

/**
 * Create a new module tab of the given kind and activate it.
 * Diff is singleton: creating while a diff tab exists focuses the existing tab
 * and does not allocate an ordinal. Multi-instance kinds (files, browser)
 * allocate the next ordinal and increment nextOrdinalByKind.
 */
export function createRightSidebarTab(
    tabs: RightSidebarTabsState,
    kind: RightSidebarTabKind,
    options?: Partial<Pick<RightSidebarOpenTab, 'title' | 'specificName' | 'sourceLabel'>>,
): RightSidebarTabsState {
    if (kind === 'diff') {
        const existing = tabs.openTabs.find(t => t.kind === 'diff');
        if (existing) return { ...tabs, activeTabId: existing.id };
        const tab: RightSidebarOpenTab = {
            id: makeTabId('diff'),
            kind: 'diff',
            title: options?.title ?? RIGHT_SIDEBAR_TAB_TITLES.diff,
            specificName: options?.specificName ?? RIGHT_SIDEBAR_DIFF_DEFAULT_NAME,
            ...(options?.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
        };
        return { ...tabs, openTabs: [...tabs.openTabs, tab], activeTabId: tab.id };
    }
    const maxExisting = tabs.openTabs
        .filter(t => t.kind === kind)
        .reduce((max, t) => Math.max(max, t.ordinal ?? 1), 0);
    const ordinal = Math.max(tabs.nextOrdinalByKind[kind] ?? 1, maxExisting + 1);
    const tab: RightSidebarOpenTab = {
        id: makeTabId(kind, ordinal),
        kind,
        title: options?.title ?? RIGHT_SIDEBAR_TAB_TITLES[kind],
        specificName: options?.specificName ?? defaultSpecificName(kind, ordinal),
        ordinal,
        ...(options?.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
    };
    const nextOrdinalByKind = isMultiInstanceKind(kind)
        ? { ...tabs.nextOrdinalByKind, [kind]: ordinal + 1 }
        : tabs.nextOrdinalByKind;
    return {
        openTabs: [...tabs.openTabs, tab],
        activeTabId: tab.id,
        nextOrdinalByKind,
    };
}

/**
 * Launcher semantics: focus the first already-open tab of the requested kind;
 * if none exists, create the first tab of that kind and activate it.
 */
export function focusOrCreateFirstRightSidebarTab(
    tabs: RightSidebarTabsState,
    kind: RightSidebarTabKind,
): RightSidebarTabsState {
    const existing = tabs.openTabs.find(t => t.kind === kind);
    if (existing) {
        return { ...tabs, activeTabId: existing.id };
    }
    return createRightSidebarTab(tabs, kind);
}

/**
 * Activate a tab by id. No-op if the id is not in openTabs.
 */
export function activateRightSidebarTab(
    tabs: RightSidebarTabsState,
    tabId: string,
): RightSidebarTabsState {
    const tab = tabs.openTabs.find(t => t.id === tabId);
    if (!tab) return tabs;
    return { ...tabs, activeTabId: tabId };
}

/**
 * Update a tab's display metadata without changing tab order or the active
 * tab identity.
 */
export function updateRightSidebarTabMeta(
    tabs: RightSidebarTabsState,
    tabId: string,
    patch: Partial<Pick<RightSidebarOpenTab, 'title' | 'specificName' | 'sourceLabel'>>,
): RightSidebarTabsState {
    const idx = tabs.openTabs.findIndex(t => t.id === tabId);
    if (idx === -1) return tabs;
    const current = tabs.openTabs[idx]!;
    const next: RightSidebarOpenTab = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.specificName !== undefined ? { specificName: patch.specificName } : {}),
        ...(patch.sourceLabel !== undefined ? { sourceLabel: patch.sourceLabel } : {}),
    };
    if (next.title === current.title && next.specificName === current.specificName && next.sourceLabel === current.sourceLabel) {
        return tabs;
    }
    const openTabs = [...tabs.openTabs];
    openTabs[idx] = next;
    return { ...tabs, openTabs };
}

// --- Files module per-tab resource state (020 §5, Option B) ---

function pathBasename(path: string | null | undefined): string | null {
    if (!path) return null;
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalized.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? null;
}

/** Files tab display name: active file basename, else folder root basename, else the ordinal default. */
function filesTabSpecificName(tab: RightSidebarOpenTab, files: RightSidebarFilesTabState): string {
    return pathBasename(files.activeFilePath)
        ?? pathBasename(files.folderRootPath)
        ?? defaultSpecificName('files', tab.ordinal);
}

function applyFilesTabState(
    tabs: RightSidebarTabsState,
    tabId: string,
    patch: RightSidebarFilesTabState,
): RightSidebarTabsState {
    const idx = tabs.openTabs.findIndex(t => t.id === tabId && t.kind === 'files');
    if (idx === -1) return tabs;
    const current = tabs.openTabs[idx]!;
    const files: RightSidebarFilesTabState = { ...current.files, ...patch };
    const specificName = filesTabSpecificName(current, files);
    const sourceLabel = files.activeFilePath ?? files.folderRootPath ?? undefined;
    const openTabs = [...tabs.openTabs];
    openTabs[idx] = {
        ...current,
        files,
        specificName,
        ...(sourceLabel ? { sourceLabel } : {}),
    };
    return { ...tabs, openTabs };
}

/**
 * Repo root updates keep the sticky-manual rule: a manual repo root pins the
 * tab, instance updates are ignored while pinned, and 'follow-instance' is
 * the explicit reset that clears the pin.
 */
function applyFilesTabRepoRoot(
    tabs: RightSidebarTabsState,
    tabId: string,
    path: string | null,
    mode: 'instance' | 'manual' | 'follow-instance',
): RightSidebarTabsState {
    const tab = tabs.openTabs.find(t => t.id === tabId && t.kind === 'files');
    if (!tab) return tabs;
    if (mode === 'follow-instance') {
        return applyFilesTabState(tabs, tabId, { repoRootPath: path, repoRootMode: 'instance' });
    }
    if (mode === 'instance' && tab.files?.repoRootMode === 'manual') return tabs;
    return applyFilesTabState(tabs, tabId, { repoRootPath: path, repoRootMode: mode });
}

/**
 * Resolve the Files tab an external file-open should target: the active tab
 * when it is a Files module, else the first open Files tab, else null.
 */
export function resolveTargetFilesTab(tabs: RightSidebarTabsState): RightSidebarOpenTab | null {
    const active = tabs.openTabs.find(t => t.id === tabs.activeTabId);
    if (active?.kind === 'files') return active;
    return tabs.openTabs.find(t => t.kind === 'files') ?? null;
}

/**
 * External file open (020 §4): focus or create a Files tab, then assign the
 * file to that tab, updating its specificName/sourceLabel.
 */
export function openFileInFilesTab(
    tabs: RightSidebarTabsState,
    path: string,
): RightSidebarTabsState {
    let next = tabs;
    let target = resolveTargetFilesTab(next);
    if (!target) {
        next = createRightSidebarTab(next, 'files');
        target = next.openTabs[next.openTabs.length - 1] ?? null;
    } else {
        next = activateRightSidebarTab(next, target.id);
    }
    if (!target) return next;
    return applyFilesTabState(next, target.id, { activeFilePath: path });
}

/**
 * External folder open: focus or create a Files tab, then assign the folder
 * root. Assigning a new root clears the tab's repo-root pin.
 */
export function openFolderInFilesTab(
    tabs: RightSidebarTabsState,
    path: string | null,
): RightSidebarTabsState {
    let next = tabs;
    let target = resolveTargetFilesTab(next);
    if (!target) {
        next = createRightSidebarTab(next, 'files');
        target = next.openTabs[next.openTabs.length - 1] ?? null;
    } else {
        next = activateRightSidebarTab(next, target.id);
    }
    if (!target) return next;
    return applyFilesTabState(next, target.id, { folderRootPath: path, repoRootPath: null, repoRootMode: 'instance' });
}

// --- Browser module per-tab page state (one module tab = one page) ---

function browserHostname(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.replace(/^www\./, '') || null;
    } catch {
        return null;
    }
}

/**
 * Update a Browser module tab's page state. The tab label follows the page
 * title when known, else the hostname, else the ordinal default. Never
 * changes tab order or active tab identity.
 */
export function applyBrowserTabState(
    tabs: RightSidebarTabsState,
    tabId: string,
    patch: { url?: string; title?: string },
): RightSidebarTabsState {
    const idx = tabs.openTabs.findIndex(t => t.id === tabId && t.kind === 'browser');
    if (idx === -1) return tabs;
    const current = tabs.openTabs[idx]!;
    const url = patch.url ?? current.browser?.url;
    const title = patch.title?.trim();
    const specificName = title
        || browserHostname(url)
        || defaultSpecificName('browser', current.ordinal);
    const next: RightSidebarOpenTab = {
        ...current,
        ...(url ? { browser: { ...current.browser, url } } : {}),
        specificName,
        ...(url ? { sourceLabel: url } : {}),
    };
    if (next.specificName === current.specificName
        && next.sourceLabel === current.sourceLabel
        && next.browser?.url === current.browser?.url) {
        return tabs;
    }
    const openTabs = [...tabs.openTabs];
    openTabs[idx] = next;
    return { ...tabs, openTabs };
}

// --- Design module per-tab state (186 Phase 1) ---

/**
 * Update a Design module tab's per-tab state (pageId/projectKey/zoom). The
 * projectKey is a create-time snapshot (OD-2): once set it is never
 * overwritten by later instance switches — callers may only fill it when
 * absent. Never changes tab order or active identity.
 */
export function applyDesignTabState(
    tabs: RightSidebarTabsState,
    tabId: string,
    patch: RightSidebarDesignTabState,
): RightSidebarTabsState {
    const idx = tabs.openTabs.findIndex(t => t.id === tabId && t.kind === 'design');
    if (idx === -1) return tabs;
    const current = tabs.openTabs[idx]!;
    const design: RightSidebarDesignTabState = { ...current.design };
    if (patch.pageId !== undefined) design.pageId = patch.pageId;
    if (patch.zoom !== undefined) design.zoom = patch.zoom;
    if (patch.projectKey !== undefined && (design.projectKey === undefined || design.projectKey === null)) {
        design.projectKey = patch.projectKey;
    }
    if (design.pageId === current.design?.pageId
        && design.projectKey === current.design?.projectKey
        && design.zoom === current.design?.zoom) {
        return tabs;
    }
    const openTabs = [...tabs.openTabs];
    openTabs[idx] = { ...current, design };
    return { ...tabs, openTabs };
}

/**
 * "Open in new window/tab" from an embedded page: create a NEW Browser module
 * tab that owns the URL as its page.
 */
export function openBrowserModuleTab(
    tabs: RightSidebarTabsState,
    url: string,
): RightSidebarTabsState {
    const next = createRightSidebarTab(tabs, 'browser');
    const created = next.openTabs[next.openTabs.length - 1];
    if (!created) return next;
    return applyBrowserTabState(next, created.id, { url });
}

/**
 * Close a tab by id. If closing the active tab, activate the nearest left
 * neighbor, else nearest right. Closing the last tab leaves activeTabId null.
 */
export function closeRightSidebarTab(
    tabs: RightSidebarTabsState,
    tabId: string,
): RightSidebarTabsState {
    const idx = tabs.openTabs.findIndex(t => t.id === tabId);
    if (idx === -1) return tabs;
    const nextTabs = tabs.openTabs.filter(t => t.id !== tabId);
    let nextActiveId = tabs.activeTabId;
    if (tabs.activeTabId === tabId) {
        if (nextTabs.length === 0) {
            nextActiveId = null;
        } else {
            // nearest left, else nearest right
            const newIdx = Math.min(idx, nextTabs.length - 1);
            const preferred = idx > 0 ? nextTabs[idx - 1] : nextTabs[newIdx];
            nextActiveId = preferred?.id ?? null;
        }
    }
    return { openTabs: nextTabs, activeTabId: nextActiveId, nextOrdinalByKind: tabs.nextOrdinalByKind };
}

// --- File/folder layout helpers ---

export function fileFolderViewModeFromRatio(ratio: number): FileFolderViewMode {
    if (ratio <= FILE_FOLDER_FOLDER_ONLY_THRESHOLD) return 'folder-only';
    if (ratio >= FILE_FOLDER_FILE_ONLY_THRESHOLD) return 'file-only';
    return 'split';
}

function clampFileFolderRatio(r: number): number {
    if (typeof r !== 'number' || !Number.isFinite(r)) return FILE_FOLDER_SPLIT_RATIO_DEFAULT;
    return Math.max(0, Math.min(1, r));
}

/** Opening a file from folder-only restores the split so the file pane is visible. */
function restoreSplitOnFileOpen(layout: FileFolderLayoutState): FileFolderLayoutState {
    if (layout.mode !== 'folder-only') return layout;
    const ratio = layout.lastSplitRatio || FILE_FOLDER_SPLIT_RATIO_DEFAULT;
    return { mode: 'split', splitRatio: ratio, lastSplitRatio: ratio };
}

// --- State types ---

export type PanelLayoutState = {
    rightPanel: {
        open: boolean;
        width: number;
        tabs: RightSidebarTabsState;
        fileFolderLayout: FileFolderLayoutState;
    };
    bottomPanel: {
        open: boolean;
        height: number;
        tabs: BottomPanelTab[];
        activeTab: BottomPanelTab | null;
    };
};

type Action =
    | { type: 'SET_RIGHT_OPEN'; open: boolean }
    | { type: 'SET_RIGHT_WIDTH'; width: number }
    | { type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB'; kind: RightSidebarTabKind }
    | { type: 'CREATE_RIGHT_SIDEBAR_TAB'; kind: RightSidebarTabKind; tab?: Partial<Pick<RightSidebarOpenTab, 'title' | 'specificName' | 'sourceLabel'>> }
    | { type: 'ACTIVATE_RIGHT_SIDEBAR_TAB'; tabId: string }
    | { type: 'SET_RIGHT_SIDEBAR_TAB_META'; tabId: string; patch: Partial<Pick<RightSidebarOpenTab, 'title' | 'specificName' | 'sourceLabel'>> }
    | { type: 'CLOSE_RIGHT_SIDEBAR_TAB'; tabId: string }
    | { type: 'OPEN_FILE_IN_FILES_TAB'; path: string }
    | { type: 'OPEN_FOLDER_IN_FILES_TAB'; path: string | null }
    | { type: 'SET_FILES_TAB_FILE'; tabId: string; path: string | null }
    | { type: 'SET_FILES_TAB_ROOT'; tabId: string; path: string | null }
    | { type: 'SET_FILES_TAB_REPO_ROOT'; tabId: string; path: string | null; mode: 'instance' | 'manual' | 'follow-instance' }
    | { type: 'SET_BROWSER_TAB_STATE'; tabId: string; url?: string; title?: string }
    | { type: 'OPEN_BROWSER_MODULE_TAB'; url: string }
    | { type: 'SET_DESIGN_TAB_STATE'; tabId: string; patch: RightSidebarDesignTabState }
    | { type: 'SET_FILE_FOLDER_SPLIT_RATIO'; ratio: number }
    | { type: 'SET_FILE_FOLDER_VIEW_MODE'; mode: FileFolderViewMode }
    | { type: 'RESTORE_FILE_FOLDER_SPLIT' }
    | { type: 'SET_BOTTOM_OPEN'; open: boolean }
    | { type: 'SET_BOTTOM_HEIGHT'; height: number }
    | { type: 'OPEN_BOTTOM_TAB'; tab: BottomPanelTab }
    | { type: 'CLOSE_BOTTOM_TAB'; tab: BottomPanelTab }
    | { type: 'SET_BOTTOM_ACTIVE_TAB'; tab: BottomPanelTab }
    | { type: 'HYDRATE'; state: Partial<PanelLayoutState> };

function clampWidth(w: number): number {
    if (typeof w !== 'number' || !Number.isFinite(w)) return RIGHT_PANEL_DEFAULT_WIDTH;
    return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(w)));
}

function clampHeight(h: number): number {
    if (typeof h !== 'number' || !Number.isFinite(h)) return BOTTOM_PANEL_DEFAULT_HEIGHT;
    return Math.min(BOTTOM_PANEL_MAX_HEIGHT, Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(h)));
}

function normalizeRightPanel(panel: PanelLayoutState['rightPanel']): PanelLayoutState['rightPanel'] {
    const next = { ...panel };
    next.width = clampWidth(next.width);
    // Validate tab kinds
    const validTabs = next.tabs.openTabs.filter(t => RIGHT_SIDEBAR_TAB_KINDS.includes(t.kind));
    if (validTabs.length !== next.tabs.openTabs.length) {
        next.tabs = { ...next.tabs, openTabs: validTabs };
    }
    if (next.tabs.activeTabId && !validTabs.find(t => t.id === next.tabs.activeTabId)) {
        next.tabs = { ...next.tabs, activeTabId: validTabs[0]?.id ?? null };
    }
    // A null active id with open tabs would blank the sidebar body entirely.
    if (!next.tabs.activeTabId && validTabs.length > 0) {
        next.tabs = { ...next.tabs, activeTabId: validTabs[0]!.id };
    }
    if (next.tabs.openTabs.length === 0 && next.open) {
        // No open tabs -> close the panel
        next.open = false;
    }
    return next;
}

function reducer(state: PanelLayoutState, action: Action): PanelLayoutState {
    switch (action.type) {
        case 'SET_RIGHT_OPEN':
            return { ...state, rightPanel: { ...state.rightPanel, open: action.open } };
        case 'SET_RIGHT_WIDTH':
            return { ...state, rightPanel: { ...state.rightPanel, width: clampWidth(action.width) } };
        case 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB': {
            const nextTabs = focusOrCreateFirstRightSidebarTab(state.rightPanel.tabs, action.kind);
            return {
                ...state,
                rightPanel: { ...state.rightPanel, open: true, tabs: nextTabs },
            };
        }
        case 'CREATE_RIGHT_SIDEBAR_TAB': {
            const nextTabs = createRightSidebarTab(state.rightPanel.tabs, action.kind, action.tab);
            return {
                ...state,
                rightPanel: { ...state.rightPanel, open: true, tabs: nextTabs },
            };
        }
        case 'ACTIVATE_RIGHT_SIDEBAR_TAB': {
            const nextTabs = activateRightSidebarTab(state.rightPanel.tabs, action.tabId);
            return {
                ...state,
                rightPanel: { ...state.rightPanel, tabs: nextTabs },
            };
        }
        case 'SET_RIGHT_SIDEBAR_TAB_META': {
            const nextTabs = updateRightSidebarTabMeta(state.rightPanel.tabs, action.tabId, action.patch);
            if (nextTabs === state.rightPanel.tabs) return state;
            return {
                ...state,
                rightPanel: { ...state.rightPanel, tabs: nextTabs },
            };
        }
        case 'CLOSE_RIGHT_SIDEBAR_TAB': {
            const nextTabs = closeRightSidebarTab(state.rightPanel.tabs, action.tabId);
            const open = nextTabs.openTabs.length > 0;
            return {
                ...state,
                rightPanel: { ...state.rightPanel, open, tabs: nextTabs },
            };
        }
        case 'OPEN_FILE_IN_FILES_TAB': {
            const nextTabs = openFileInFilesTab(state.rightPanel.tabs, action.path);
            return {
                ...state,
                rightPanel: {
                    ...state.rightPanel,
                    open: true,
                    tabs: nextTabs,
                    fileFolderLayout: restoreSplitOnFileOpen(state.rightPanel.fileFolderLayout),
                },
            };
        }
        case 'OPEN_FOLDER_IN_FILES_TAB': {
            const nextTabs = openFolderInFilesTab(state.rightPanel.tabs, action.path);
            return {
                ...state,
                rightPanel: { ...state.rightPanel, open: true, tabs: nextTabs },
            };
        }
        case 'SET_FILES_TAB_FILE': {
            const nextTabs = applyFilesTabState(state.rightPanel.tabs, action.tabId, { activeFilePath: action.path });
            if (nextTabs === state.rightPanel.tabs) return state;
            const fileFolderLayout = action.path
                ? restoreSplitOnFileOpen(state.rightPanel.fileFolderLayout)
                : state.rightPanel.fileFolderLayout;
            return { ...state, rightPanel: { ...state.rightPanel, tabs: nextTabs, fileFolderLayout } };
        }
        case 'SET_FILES_TAB_ROOT': {
            const nextTabs = applyFilesTabState(state.rightPanel.tabs, action.tabId, { folderRootPath: action.path, repoRootPath: null, repoRootMode: 'instance' });
            if (nextTabs === state.rightPanel.tabs) return state;
            return { ...state, rightPanel: { ...state.rightPanel, tabs: nextTabs } };
        }
        case 'SET_FILES_TAB_REPO_ROOT': {
            const nextTabs = applyFilesTabRepoRoot(state.rightPanel.tabs, action.tabId, action.path, action.mode);
            if (nextTabs === state.rightPanel.tabs) return state;
            return { ...state, rightPanel: { ...state.rightPanel, tabs: nextTabs } };
        }
        case 'SET_BROWSER_TAB_STATE': {
            const patch: { url?: string; title?: string } = {};
            if (action.url !== undefined) patch.url = action.url;
            if (action.title !== undefined) patch.title = action.title;
            const nextTabs = applyBrowserTabState(state.rightPanel.tabs, action.tabId, patch);
            if (nextTabs === state.rightPanel.tabs) return state;
            return { ...state, rightPanel: { ...state.rightPanel, tabs: nextTabs } };
        }
        case 'OPEN_BROWSER_MODULE_TAB': {
            const nextTabs = openBrowserModuleTab(state.rightPanel.tabs, action.url);
            return {
                ...state,
                rightPanel: { ...state.rightPanel, open: true, tabs: nextTabs },
            };
        }
        case 'SET_DESIGN_TAB_STATE': {
            const nextTabs = applyDesignTabState(state.rightPanel.tabs, action.tabId, action.patch);
            if (nextTabs === state.rightPanel.tabs) return state;
            return { ...state, rightPanel: { ...state.rightPanel, tabs: nextTabs } };
        }
        case 'SET_FILE_FOLDER_SPLIT_RATIO': {
            const ratio = clampFileFolderRatio(action.ratio);
            const mode = fileFolderViewModeFromRatio(ratio);
            const lastSplitRatio = mode === 'split' ? ratio : state.rightPanel.fileFolderLayout.lastSplitRatio;
            return {
                ...state,
                rightPanel: {
                    ...state.rightPanel,
                    fileFolderLayout: { mode, splitRatio: ratio, lastSplitRatio },
                },
            };
        }
        case 'SET_FILE_FOLDER_VIEW_MODE': {
            const ffl = state.rightPanel.fileFolderLayout;
            if (action.mode === ffl.mode) return state;
            let ratio = ffl.splitRatio;
            let lastSplitRatio = ffl.lastSplitRatio;
            if (action.mode === 'folder-only') ratio = 0;
            else if (action.mode === 'file-only') ratio = 1;
            else {
                ratio = lastSplitRatio || FILE_FOLDER_SPLIT_RATIO_DEFAULT;
                lastSplitRatio = ratio;
            }
            return {
                ...state,
                rightPanel: {
                    ...state.rightPanel,
                    fileFolderLayout: { mode: action.mode, splitRatio: ratio, lastSplitRatio },
                },
            };
        }
        case 'RESTORE_FILE_FOLDER_SPLIT': {
            const ffl = state.rightPanel.fileFolderLayout;
            const ratio = ffl.lastSplitRatio || FILE_FOLDER_SPLIT_RATIO_DEFAULT;
            return {
                ...state,
                rightPanel: {
                    ...state.rightPanel,
                    fileFolderLayout: { mode: 'split', splitRatio: ratio, lastSplitRatio: ratio },
                },
            };
        }
        case 'SET_BOTTOM_OPEN':
            return { ...state, bottomPanel: { ...state.bottomPanel, open: action.open } };
        case 'SET_BOTTOM_HEIGHT':
            return { ...state, bottomPanel: { ...state.bottomPanel, height: clampHeight(action.height) } };
        case 'OPEN_BOTTOM_TAB': {
            const bp = state.bottomPanel;
            const tabs = bp.tabs.includes(action.tab) ? bp.tabs : [...bp.tabs, action.tab];
            return { ...state, bottomPanel: { ...bp, open: true, tabs, activeTab: action.tab } };
        }
        case 'CLOSE_BOTTOM_TAB': {
            const bp = state.bottomPanel;
            const tabs = bp.tabs.filter(t => t !== action.tab);
            const activeTab = bp.activeTab === action.tab ? (tabs[0] ?? null) : bp.activeTab;
            const open = tabs.length > 0;
            return { ...state, bottomPanel: { ...bp, tabs, activeTab, open } };
        }
        case 'SET_BOTTOM_ACTIVE_TAB':
            return { ...state, bottomPanel: { ...state.bottomPanel, activeTab: action.tab } };
        case 'HYDRATE': {
            const h = action.state;
            const rp = normalizeRightPanel({ ...state.rightPanel, ...h.rightPanel });
            const bp = { ...state.bottomPanel, ...h.bottomPanel };
            bp.height = clampHeight(bp.height);
            bp.tabs = (bp.tabs ?? []).filter(t => BOTTOM_PANEL_TABS.includes(t));
            if (bp.activeTab !== null && !bp.tabs.includes(bp.activeTab)) bp.activeTab = bp.tabs[0] ?? null;
            return { rightPanel: rp, bottomPanel: bp };
        }
        default:
            return state;
    }
}

const defaultFileFolderLayout: FileFolderLayoutState = {
    mode: 'split',
    splitRatio: FILE_FOLDER_SPLIT_RATIO_DEFAULT,
    lastSplitRatio: FILE_FOLDER_SPLIT_RATIO_DEFAULT,
};

const defaultTabsState: RightSidebarTabsState = {
    openTabs: [],
    activeTabId: null,
    nextOrdinalByKind: {},
};

const initialState: PanelLayoutState = {
    rightPanel: {
        open: false,
        width: RIGHT_PANEL_DEFAULT_WIDTH,
        tabs: defaultTabsState,
        fileFolderLayout: defaultFileFolderLayout,
    },
    bottomPanel: {
        open: false,
        height: BOTTOM_PANEL_DEFAULT_HEIGHT,
        tabs: [],
        activeTab: null,
    },
};

type PanelLayoutContextValue = {
    state: PanelLayoutState;
    dispatch: React.Dispatch<Action>;
    effectiveRightOpen: boolean;
    activeRightTabKind: RightSidebarTabKind | null;
};

const PanelLayoutContext = createContext<PanelLayoutContextValue | null>(null);

type TerminalShortcutQueueWindow = Window & {
    __cliJawPendingTerminalActions?: Array<'focusTerminal' | 'newTerminalSession'>;
};

function dispatchTerminalShortcutAfterMount(detail: 'focusTerminal' | 'newTerminalSession'): void {
    const win = window as TerminalShortcutQueueWindow;
    win.__cliJawPendingTerminalActions = [...(win.__cliJawPendingTerminalActions ?? []), detail];
    window.setTimeout(() => {
        document.dispatchEvent(new CustomEvent('jaw:shortcut-action', { detail: 'flushTerminalShortcutQueue' }));
    }, 0);
}

function getActiveRightTabKind(state: PanelLayoutState): RightSidebarTabKind | null {
    const { tabs } = state.rightPanel;
    if (!tabs.activeTabId) return null;
    const tab = tabs.openTabs.find(t => t.id === tabs.activeTabId);
    return tab?.kind ?? null;
}

export function PanelLayoutProvider(props: {
    children: ReactNode;
    initialPanelState?: Partial<PanelLayoutState> | undefined;
    onStateChange?: ((state: PanelLayoutState) => void) | undefined;
}) {
    const [state, dispatch] = useReducer(reducer, initialState);

    const hydratedRef = useRef(false);
    useEffect(() => {
        if (!props.initialPanelState || hydratedRef.current) return;
        hydratedRef.current = true;
        dispatch({ type: 'HYDRATE', state: props.initialPanelState });
    }, [props.initialPanelState]);

    const onChangeRef = useRef(props.onStateChange);
    onChangeRef.current = props.onStateChange;
    useEffect(() => {
        if (!onChangeRef.current) return;
        const timer = setTimeout(() => onChangeRef.current?.(state), 300);
        return () => clearTimeout(timer);
    }, [state]);

    const effectiveRightOpen = state.rightPanel.open && state.rightPanel.tabs.openTabs.length > 0 && state.rightPanel.tabs.activeTabId !== null;
    const activeRightTabKind = getActiveRightTabKind(state);

    useEffect(() => {
        return panelShortcutBus.register((action) => {
            switch (action) {
                case 'toggleBottomPanel':
                    if (state.bottomPanel.open) dispatch({ type: 'SET_BOTTOM_OPEN', open: false });
                    else dispatch({ type: 'OPEN_BOTTOM_TAB', tab: 'terminal' });
                    return true;
                case 'toggleRightPanel':
                    if (effectiveRightOpen) {
                        dispatch({ type: 'SET_RIGHT_OPEN', open: false });
                    } else {
                        dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind: 'files' });
                    }
                    return true;
                case 'focusTerminal':
                    dispatch({ type: 'OPEN_BOTTOM_TAB', tab: 'terminal' });
                    dispatchTerminalShortcutAfterMount('focusTerminal');
                    return true;
                case 'newTerminalSession':
                    dispatch({ type: 'OPEN_BOTTOM_TAB', tab: 'terminal' });
                    dispatchTerminalShortcutAfterMount('newTerminalSession');
                    return true;
                case 'openDiff':
                    dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind: 'diff' });
                    return true;
                case 'openFolderTree':
                    dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind: 'files' });
                    return true;
                case 'closeActiveBottomTab':
                    if (state.bottomPanel.activeTab) {
                        dispatch({ type: 'CLOSE_BOTTOM_TAB', tab: state.bottomPanel.activeTab });
                    }
                    return true;
                default:
                    return false;
            }
        });
    }, [state.bottomPanel.open, state.bottomPanel.activeTab, effectiveRightOpen]);

    const value = useMemo(() => ({
        state, dispatch, effectiveRightOpen, activeRightTabKind,
    }), [state, effectiveRightOpen, activeRightTabKind]);

    return (
        <PanelLayoutContext.Provider value={value}>
            {props.children}
        </PanelLayoutContext.Provider>
    );
}

export function usePanelLayout(): PanelLayoutContextValue {
    const ctx = useContext(PanelLayoutContext);
    if (!ctx) throw new Error('usePanelLayout must be used within PanelLayoutProvider');
    return ctx;
}

export function usePanelActions() {
    const { dispatch, state } = usePanelLayout();

    return useMemo(() => ({
        focusOrCreateFirstRightSidebarTab: (kind: RightSidebarTabKind) =>
            dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind }),
        createRightSidebarTab: (kind: RightSidebarTabKind, tab?: Partial<Pick<RightSidebarOpenTab, 'title' | 'specificName' | 'sourceLabel'>>) =>
            dispatch({ type: 'CREATE_RIGHT_SIDEBAR_TAB', kind, ...(tab ? { tab } : {}) }),
        activateRightSidebarTab: (tabId: string) =>
            dispatch({ type: 'ACTIVATE_RIGHT_SIDEBAR_TAB', tabId }),
        setRightSidebarTabMeta: (tabId: string, patch: Partial<Pick<RightSidebarOpenTab, 'title' | 'specificName' | 'sourceLabel'>>) =>
            dispatch({ type: 'SET_RIGHT_SIDEBAR_TAB_META', tabId, patch }),
        closeRightSidebarTab: (tabId: string) =>
            dispatch({ type: 'CLOSE_RIGHT_SIDEBAR_TAB', tabId }),
        setRightWidth: (width: number) =>
            dispatch({ type: 'SET_RIGHT_WIDTH', width }),
        setFileFolderSplitRatio: (ratio: number) =>
            dispatch({ type: 'SET_FILE_FOLDER_SPLIT_RATIO', ratio }),
        setFileFolderViewMode: (mode: FileFolderViewMode) =>
            dispatch({ type: 'SET_FILE_FOLDER_VIEW_MODE', mode }),
        restoreFileFolderSplit: () =>
            dispatch({ type: 'RESTORE_FILE_FOLDER_SPLIT' }),
        toggleRightPanel: () =>
            state.rightPanel.open && state.rightPanel.tabs.openTabs.length > 0
                ? dispatch({ type: 'SET_RIGHT_OPEN', open: false })
                : dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind: 'files' }),
        openBottomTab: (tab: BottomPanelTab) =>
            dispatch({ type: 'OPEN_BOTTOM_TAB', tab }),
        closeBottomTab: (tab: BottomPanelTab) =>
            dispatch({ type: 'CLOSE_BOTTOM_TAB', tab }),
        setBottomActiveTab: (tab: BottomPanelTab) =>
            dispatch({ type: 'SET_BOTTOM_ACTIVE_TAB', tab }),
        setBottomHeight: (height: number) =>
            dispatch({ type: 'SET_BOTTOM_HEIGHT', height }),
        toggleBottomPanel: () =>
            state.bottomPanel.open
                ? dispatch({ type: 'SET_BOTTOM_OPEN', open: false })
                : dispatch({ type: 'OPEN_BOTTOM_TAB', tab: 'terminal' }),
        hydrate: (s: Partial<PanelLayoutState>) =>
            dispatch({ type: 'HYDRATE', state: s }),
    }), [dispatch, state.rightPanel.open, state.bottomPanel.open]);
}
