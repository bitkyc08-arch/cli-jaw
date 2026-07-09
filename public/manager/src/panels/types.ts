export type RightPanelMode = 'folder' | 'diff' | 'browser' | 'ceo';
export type BottomPanelTab = 'terminal' | 'browser' | 'logs' | 'activity';

export const RIGHT_PANEL_MODES: RightPanelMode[] = ['folder', 'diff', 'browser', 'ceo'];
export const BOTTOM_PANEL_TABS: BottomPanelTab[] = ['terminal', 'browser', 'logs', 'activity'];

export const RIGHT_PANEL_MIN_WIDTH = 260;
export const RIGHT_PANEL_MAX_WIDTH = 9999;
export const RIGHT_PANEL_DEFAULT_WIDTH = 480;

export const BOTTOM_PANEL_MIN_HEIGHT = 180;
export const BOTTOM_PANEL_MAX_HEIGHT = 520;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 320;

// --- Right sidebar tab model (020) ---

export type RightSidebarTabKind = 'files' | 'diff' | 'browser' | 'design';

/** Per-tab page state for a Browser module tab: one module tab = one page. */
export type RightSidebarBrowserTabState = {
    url?: string;
};

/** Per-tab state for a Design module tab. One tab = one selected page (186). */
export type RightSidebarDesignTabState = {
    pageId?: string | null;
    /** Bound project key, frozen from the selected instance's projectDir at tab create (OD-2 snapshot). */
    projectKey?: string | null;
    zoom?: number;
};

/** Per-tab resource state for a Files module tab (020 §5, Option B). */
export type RightSidebarFilesTabState = {
    activeFilePath?: string | null;
    folderRootPath?: string | null;
    repoRootPath?: string | null;
    repoRootMode?: 'instance' | 'manual';
};

export type RightSidebarOpenTab = {
    id: string;
    kind: RightSidebarTabKind;
    title: string;
    /** Concrete instance label rendered in the tab (e.g. file basename, page title). */
    specificName: string;
    /** Full source detail for tooltips/aria (e.g. full path, URL). */
    sourceLabel?: string;
    /** Instance number for multi-instance kinds (right-files-2 -> 2). */
    ordinal?: number;
    pinned?: boolean;
    /** Files-kind per-tab resource state. Absent on diff/browser tabs. */
    files?: RightSidebarFilesTabState;
    /** Browser-kind per-tab page state. One module tab owns one page. */
    browser?: RightSidebarBrowserTabState;
    /** Design-kind per-tab state. Absent on other kinds. */
    design?: RightSidebarDesignTabState;
};

export type RightSidebarTabsState = {
    openTabs: RightSidebarOpenTab[];
    activeTabId: string | null;
    nextOrdinalByKind: Partial<Record<RightSidebarTabKind, number>>;
};

export const RIGHT_SIDEBAR_TAB_KINDS: RightSidebarTabKind[] = ['files', 'diff', 'browser', 'design'];

export const RIGHT_SIDEBAR_TAB_TITLES: Record<RightSidebarTabKind, string> = {
    files: 'Files',
    diff: 'Diff',
    browser: 'Browser',
    design: 'Design',
};

/** Kinds that may have multiple simultaneous module tabs. Diff stays singleton. */
export const RIGHT_SIDEBAR_MULTI_INSTANCE_KINDS: RightSidebarTabKind[] = ['files', 'browser', 'design'];

export const RIGHT_SIDEBAR_DIFF_DEFAULT_NAME = 'Working tree';

// --- Files tab inner layout (010) ---

export type FileFolderViewMode = 'split' | 'folder-only' | 'file-only';

export type FileFolderLayoutState = {
    mode: FileFolderViewMode;
    splitRatio: number;
    lastSplitRatio: number;
};

export const FILE_FOLDER_SPLIT_RATIO_DEFAULT = 0.5;
export const FILE_FOLDER_FOLDER_ONLY_THRESHOLD = 0.12;
export const FILE_FOLDER_FILE_ONLY_THRESHOLD = 0.88;
