import type { DashboardRegistryUi } from '../types';
import type { PanelLayoutState } from './PanelLayoutProvider';
import type { BottomPanelTab, RightSidebarTabKind, RightSidebarOpenTab, RightSidebarTabsState, FileFolderLayoutState } from './types';
import {
    BOTTOM_PANEL_DEFAULT_HEIGHT, RIGHT_PANEL_DEFAULT_WIDTH,
    RIGHT_SIDEBAR_TAB_TITLES, RIGHT_SIDEBAR_TAB_KINDS,
    RIGHT_SIDEBAR_MULTI_INSTANCE_KINDS, RIGHT_SIDEBAR_DIFF_DEFAULT_NAME,
    FILE_FOLDER_SPLIT_RATIO_DEFAULT,
} from './types';
import { fileFolderViewModeFromRatio } from './PanelLayoutProvider';

// --- Legacy hydration helpers ---

type LegacyRightPanelMode = 'folder' | 'doc' | 'diff' | 'browser' | 'ceo';

/**
 * Map a legacy right panel mode (from top/bottom slot) to the new tab kind.
 * 'folder' and 'doc' both map to 'files'; 'ceo' maps to 'files' (hidden in v1).
 */
function legacyModeToKind(mode: LegacyRightPanelMode | string | null): RightSidebarTabKind | null {
    if (!mode) return null;
    switch (mode) {
        case 'folder':
        case 'doc':
        case 'ceo':
            return 'files';
        case 'diff':
            return 'diff';
        case 'browser':
            return 'browser';
        default:
            return null;
    }
}

function makeTabId(kind: RightSidebarTabKind, ordinal?: number): string {
    return kind === 'diff' ? 'right-diff' : `right-${kind}-${ordinal ?? 1}`;
}

function defaultSpecificName(kind: RightSidebarTabKind, ordinal?: number): string {
    if (kind === 'diff') return RIGHT_SIDEBAR_DIFF_DEFAULT_NAME;
    return `${RIGHT_SIDEBAR_TAB_TITLES[kind]} ${ordinal ?? 1}`;
}

function makeTab(kind: RightSidebarTabKind): RightSidebarOpenTab {
    if (kind === 'diff') {
        return { id: makeTabId('diff'), kind, title: RIGHT_SIDEBAR_TAB_TITLES.diff, specificName: RIGHT_SIDEBAR_DIFF_DEFAULT_NAME };
    }
    return { id: makeTabId(kind, 1), kind, title: RIGHT_SIDEBAR_TAB_TITLES[kind], specificName: defaultSpecificName(kind, 1), ordinal: 1 };
}

/** Compute nextOrdinalByKind from open tabs: max existing ordinal + 1 per multi-instance kind. */
function computeNextOrdinals(
    openTabs: RightSidebarOpenTab[],
    persisted?: Record<string, number> | undefined,
): Partial<Record<RightSidebarTabKind, number>> {
    const next: Partial<Record<RightSidebarTabKind, number>> = {};
    for (const kind of RIGHT_SIDEBAR_MULTI_INSTANCE_KINDS) {
        const maxOrdinal = openTabs
            .filter(t => t.kind === kind)
            .reduce((max, t) => Math.max(max, t.ordinal ?? 1), 0);
        const persistedValue = typeof persisted?.[kind] === 'number' && Number.isFinite(persisted[kind])
            ? persisted[kind]
            : 0;
        const computed = Math.max(persistedValue, maxOrdinal + 1);
        if (computed > 1 || maxOrdinal > 0) next[kind] = computed;
    }
    return next;
}

/**
 * Build RightSidebarTabsState from legacy top/bottom modes.
 * Deduplicates so that e.g. folder+doc both mapping to 'files' produces one tab.
 */
function hydrateLegacyTabs(
    topMode: string | null | undefined,
    bottomMode: string | null | undefined,
): RightSidebarTabsState {
    const seenKinds = new Set<RightSidebarTabKind>();
    const openTabs: RightSidebarOpenTab[] = [];
    let activeKind: RightSidebarTabKind | null = null;

    for (const mode of [topMode, bottomMode]) {
        const kind = legacyModeToKind(mode as LegacyRightPanelMode);
        if (kind && !seenKinds.has(kind)) {
            seenKinds.add(kind);
            openTabs.push(makeTab(kind));
            if (!activeKind) activeKind = kind;
        }
    }

    const activeTabId = activeKind
        ? (openTabs.find(t => t.kind === activeKind)?.id ?? null)
        : null;

    return { openTabs, activeTabId, nextOrdinalByKind: computeNextOrdinals(openTabs) };
}

type RawPersistedTab = {
    id?: unknown;
    kind?: unknown;
    title?: unknown;
    specificName?: unknown;
    sourceLabel?: unknown;
    ordinal?: unknown;
    pinned?: unknown;
    files?: unknown;
    browser?: unknown;
    design?: unknown;
};

function normalizePersistedDesignState(raw: unknown): RightSidebarOpenTab['design'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = raw as { pageId?: unknown; projectKey?: unknown; zoom?: unknown };
    const design: NonNullable<RightSidebarOpenTab['design']> = {};
    if (typeof value.pageId === 'string' && value.pageId.length > 0) design.pageId = value.pageId;
    if (typeof value.projectKey === 'string' && value.projectKey.length > 0) design.projectKey = value.projectKey;
    if (typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom > 0) design.zoom = value.zoom;
    return Object.keys(design).length > 0 ? design : undefined;
}

function normalizePersistedBrowserState(raw: unknown): RightSidebarOpenTab['browser'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = raw as { url?: unknown };
    if (typeof value.url === 'string' && value.url.length > 0) return { url: value.url };
    return undefined;
}

function normalizePersistedFilesState(raw: unknown): RightSidebarOpenTab['files'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = raw as { activeFilePath?: unknown; folderRootPath?: unknown; repoRootPath?: unknown; repoRootMode?: unknown };
    const files: NonNullable<RightSidebarOpenTab['files']> = {};
    if (typeof value.activeFilePath === 'string' && value.activeFilePath.length > 0) files.activeFilePath = value.activeFilePath;
    if (typeof value.folderRootPath === 'string' && value.folderRootPath.length > 0) files.folderRootPath = value.folderRootPath;
    if (typeof value.repoRootPath === 'string' && value.repoRootPath.length > 0) files.repoRootPath = value.repoRootPath;
    if (value.repoRootMode === 'instance' || value.repoRootMode === 'manual') files.repoRootMode = value.repoRootMode;
    return Object.keys(files).length > 0 ? files : undefined;
}

/** Infer an instance ordinal from a persisted tab id suffix (right-files-2 -> 2). */
function inferOrdinalFromId(id: string): number | undefined {
    const match = /-(\d+)$/.exec(id);
    if (!match) return undefined;
    const parsed = Number.parseInt(match[1]!, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Normalize one persisted tab: drop invalid kinds, fill missing title and
 * specificName, infer ordinal from the id suffix, preserve pinned/sourceLabel.
 * Legacy singleton ids (right-files) stay readable and migrate to the new
 * shape on the next persisted write.
 */
function normalizePersistedTab(raw: RawPersistedTab): RightSidebarOpenTab | null {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) return null;
    if (typeof raw.kind !== 'string' || !RIGHT_SIDEBAR_TAB_KINDS.includes(raw.kind as RightSidebarTabKind)) return null;
    const kind = raw.kind as RightSidebarTabKind;
    const ordinal = typeof raw.ordinal === 'number' && Number.isFinite(raw.ordinal) && raw.ordinal > 0
        ? Math.floor(raw.ordinal)
        : inferOrdinalFromId(raw.id);
    const title = typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : RIGHT_SIDEBAR_TAB_TITLES[kind];
    const specificName = typeof raw.specificName === 'string' && raw.specificName.length > 0
        ? raw.specificName
        : defaultSpecificName(kind, ordinal);
    const files = kind === 'files' ? normalizePersistedFilesState(raw.files) : undefined;
    const browser = kind === 'browser' ? normalizePersistedBrowserState(raw.browser) : undefined;
    const design = kind === 'design' ? normalizePersistedDesignState(raw.design) : undefined;
    return {
        id: raw.id,
        kind,
        title,
        specificName,
        ...(typeof raw.sourceLabel === 'string' && raw.sourceLabel.length > 0 ? { sourceLabel: raw.sourceLabel } : {}),
        ...(kind !== 'diff' && ordinal !== undefined ? { ordinal } : {}),
        ...(raw.pinned === true ? { pinned: true } : {}),
        ...(files ? { files } : {}),
        ...(browser ? { browser } : {}),
        ...(design ? { design } : {}),
    };
}

function hydrateTabsState(ui: DashboardRegistryUi): RightSidebarTabsState {
    // New-format fields present
    if (ui.rightSidebarOpenTabs) {
        const raw = ui.rightSidebarOpenTabs as RawPersistedTab[];
        const openTabs: RightSidebarOpenTab[] = [];
        const seenIds = new Set<string>();
        let diffSeen = false;
        for (const entry of raw) {
            const tab = normalizePersistedTab(entry);
            if (!tab) continue;
            // Corrupted registries can carry duplicate ids; duplicates would
            // produce duplicate React keys and unstable rendering.
            if (seenIds.has(tab.id)) continue;
            if (tab.kind === 'diff') {
                // Enforce one Diff tab max.
                if (diffSeen) continue;
                diffSeen = true;
            }
            seenIds.add(tab.id);
            openTabs.push(tab);
        }
        const activeTabId = typeof ui.rightSidebarActiveTabId === 'string'
            ? (openTabs.find(t => t.id === ui.rightSidebarActiveTabId) ? ui.rightSidebarActiveTabId : openTabs[0]?.id ?? null)
            : openTabs[0]?.id ?? null;
        const nextOrdinalByKind = computeNextOrdinals(openTabs, ui.rightSidebarNextOrdinalByKind);
        return { openTabs, activeTabId, nextOrdinalByKind };
    }

    // Legacy format: migrate from topMode/bottomMode
    if (ui.rightPanelTopMode !== undefined || ui.rightPanelBottomMode !== undefined) {
        return hydrateLegacyTabs(ui.rightPanelTopMode, ui.rightPanelBottomMode);
    }

    // No state at all: empty
    return { openTabs: [], activeTabId: null, nextOrdinalByKind: {} };
}

function hydrateFileFolderLayout(ui: DashboardRegistryUi): FileFolderLayoutState {
    const raw = ui.fileFolderLayout as { mode?: string; splitRatio?: number; lastSplitRatio?: number } | undefined;
    if (raw && typeof raw === 'object') {
        const splitRatio = typeof raw.splitRatio === 'number' && Number.isFinite(raw.splitRatio)
            ? Math.max(0, Math.min(1, raw.splitRatio))
            : FILE_FOLDER_SPLIT_RATIO_DEFAULT;
        const lastSplitRatio = typeof raw.lastSplitRatio === 'number' && Number.isFinite(raw.lastSplitRatio)
            ? Math.max(0, Math.min(1, raw.lastSplitRatio))
            : FILE_FOLDER_SPLIT_RATIO_DEFAULT;
        const mode = raw.mode === 'split' || raw.mode === 'folder-only' || raw.mode === 'file-only'
            ? raw.mode
            : fileFolderViewModeFromRatio(splitRatio);
        return { mode, splitRatio, lastSplitRatio };
    }
    return {
        mode: 'split',
        splitRatio: FILE_FOLDER_SPLIT_RATIO_DEFAULT,
        lastSplitRatio: FILE_FOLDER_SPLIT_RATIO_DEFAULT,
    };
}

export function panelLayoutInitialStateFromUi(ui: DashboardRegistryUi): Partial<PanelLayoutState> {
    if (!ui.panelLayoutVersion) return {};
    const tabs = hydrateTabsState(ui);
    const fileFolderLayout = hydrateFileFolderLayout(ui);
    return {
        rightPanel: {
            open: ui.rightPanelOpen ?? false,
            width: ui.rightPanelWidth ?? RIGHT_PANEL_DEFAULT_WIDTH,
            tabs,
            fileFolderLayout,
        },
        bottomPanel: {
            open: ui.bottomPanelOpen ?? false,
            height: ui.bottomPanelHeight ?? BOTTOM_PANEL_DEFAULT_HEIGHT,
            tabs: (ui.bottomPanelTabs ?? []) as BottomPanelTab[],
            activeTab: (ui.bottomPanelActiveTab ?? null) as BottomPanelTab | null,
        },
    };
}

export function panelLayoutUiFromState(state: PanelLayoutState): Partial<DashboardRegistryUi> {
    return {
        panelLayoutVersion: 2,
        rightPanelOpen: state.rightPanel.open,
        rightPanelWidth: state.rightPanel.width,
        // New tab fields
        rightSidebarOpenTabs: state.rightPanel.tabs.openTabs as unknown as DashboardRegistryUi['rightSidebarOpenTabs'],
        rightSidebarActiveTabId: state.rightPanel.tabs.activeTabId,
        rightSidebarNextOrdinalByKind: state.rightPanel.tabs.nextOrdinalByKind as unknown as DashboardRegistryUi['rightSidebarNextOrdinalByKind'],
        fileFolderLayout: state.rightPanel.fileFolderLayout as unknown as DashboardRegistryUi['fileFolderLayout'],
        // Clear legacy fields
        rightPanelTopMode: undefined,
        rightPanelBottomMode: undefined,
        rightPanelSplitRatio: undefined,
        rightSidebarLastActiveByKind: undefined,
        // Bottom panel (unchanged)
        bottomPanelOpen: state.bottomPanel.open,
        bottomPanelHeight: state.bottomPanel.height,
        bottomPanelTabs: state.bottomPanel.tabs,
        bottomPanelActiveTab: state.bottomPanel.activeTab,
    };
}
