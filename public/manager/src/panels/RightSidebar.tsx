import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PanelResizer } from './PanelResizer';
import { usePanelLayout } from './PanelLayoutProvider';
import type { RightSidebarOpenTab, RightSidebarTabKind } from './types';
import { RIGHT_SIDEBAR_TAB_TITLES } from './types';
import { getRightSidebarTabDisplay, getRightSidebarTabDensity } from './right-sidebar-tab-display';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { getDesktop } from './desktop-bridge';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type RightSidebarProps = {
    renderPanel: (kind: RightSidebarTabKind, tab: RightSidebarOpenTab) => ReactNode;
    /** Files-tab scoped "load project folder" action (불러오기). */
    onLoadProjectFolder?: (() => void) | undefined;
    loadProjectFolderDisabled?: boolean | undefined;
};

// ---------------------------------------------------------------------------
// Icons (lucide-style strokes; icons derive from tab kind at render time)
// ---------------------------------------------------------------------------

function CloseIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M6 6l8 8M14 6l-8 8" />
        </svg>
    );
}

function TabCloseIcon() {
    return (
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}

function PlusIcon() {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M8 3v10M3 8h10" />
        </svg>
    );
}

function FilesKindIcon() {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M2 4.5h4.5L8 6h6v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
            <path d="M2 4.5V3.5a1 1 0 0 1 1-1h2.5L7 4h5a1 1 0 0 1 1 1v1" />
        </svg>
    );
}

function DiffKindIcon() {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M4 3v10M12 3v10M4 8h8" />
        </svg>
    );
}

function BrowserKindIcon() {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="2" y="2" width="12" height="12" rx="1.5" />
            <path d="M2 5.5h12" />
        </svg>
    );
}

function DesignKindIcon() {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M9.5 3.5l3 3L6 13H3v-3Z" />
            <path d="M8 5l3 3" />
            <path d="M12.5 6.5l1-1a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0l-1 1" />
        </svg>
    );
}

function FolderToggleIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 6.5h5l1.4 1.8H17v6.2A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5v-8Z" />
            <path d="M3 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3L9 5.5h6.5A1.5 1.5 0 0 1 17 7v1.3" />
        </svg>
    );
}

function ChevronSep() {
    return (
        <span className="right-breadcrumb-sep" aria-hidden="true">&gt;</span>
    );
}

const TAB_KIND_ICONS: Record<RightSidebarTabKind, () => ReactNode> = {
    files: FilesKindIcon,
    diff: DiffKindIcon,
    browser: BrowserKindIcon,
    design: DesignKindIcon,
};

// ---------------------------------------------------------------------------
// Breadcrumb helper
// ---------------------------------------------------------------------------

function parseBreadcrumb(filePath: string | null | undefined): string[] {
    if (!filePath) return [];
    // Normalize path separators and split
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    // Try to make the path relative-looking: strip common unix roots
    if (segments.length > 0 && segments[0] === '') segments.shift();
    return segments;
}

// ---------------------------------------------------------------------------
// Launcher / plus menu kinds. CEO is hidden and never rendered here.
// ---------------------------------------------------------------------------

const LAUNCHER_KINDS: RightSidebarTabKind[] = ['files', 'diff', 'browser', 'design'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Right sidebar with the 020/021 open-tab chrome:
 *
 * - Launcher button row: icon-only Files/Diff/Browser launchers (CEO hidden)
 *   plus the close-sidebar control. Launchers focus the first open tab of the
 *   kind or create it (FOCUS_OR_CREATE semantics).
 * - Open tab strip: equal-width module tabs (kind icon + specific instance
 *   name, hover/focus-revealed close) and a fixed-width '+' opening a menu.
 *   The '+' menu CREATES new Files/Browser instances; Diff is omitted from
 *   the menu while a Diff tab exists.
 * - Files one-line toolbar (breadcrumb, Open file, folder toggle) when the
 *   active tab is a Files module. No tab-in-tab, no inner '+'.
 * - Tab bodies stay mounted (hidden) when switching away so each module tab
 *   keeps its own component state.
 */
export function RightSidebar(props: RightSidebarProps) {
    const { state, dispatch, effectiveRightOpen, activeRightTabKind } = usePanelLayout();
    const rp = state.rightPanel;
    const widthRef = useRef(rp.width);

    useEffect(() => {
        widthRef.current = rp.width;
    }, [rp.width]);

    const handleWidthDelta = useCallback((delta: number) => {
        const width = widthRef.current - delta;
        widthRef.current = width;
        dispatch({ type: 'SET_RIGHT_WIDTH', width });
    }, [dispatch]);

    const handleWidthEnd = useCallback(() => {
        // save trigger handled by parent persistence layer
    }, []);

    // Plus menu open state
    const [plusMenuOpen, setPlusMenuOpen] = useState(false);
    const plusMenuRef = useRef<HTMLDivElement>(null);

    // Close plus menu on outside click
    useEffect(() => {
        if (!plusMenuOpen) return;
        function handleClick(e: MouseEvent) {
            if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
                setPlusMenuOpen(false);
            }
        }
        document.addEventListener('click', handleClick, true);
        return () => document.removeEventListener('click', handleClick, true);
    }, [plusMenuOpen]);

    // -- Derived --
    const openTabs = rp.tabs.openTabs;
    const activeTabId = rp.tabs.activeTabId;
    const activeTab = openTabs.find(t => t.id === activeTabId) ?? null;
    const fileFolderLayout = rp.fileFolderLayout;
    // Breadcrumb follows the ACTIVE Files module tab's own file (per-tab state).
    const activeFilePath = activeTab?.kind === 'files' ? activeTab.files?.activeFilePath ?? null : null;
    const density = getRightSidebarTabDensity(openTabs.length);

    // '+' menu entries: Files/Browser always creatable; Diff omitted while open.
    const diffOpen = openTabs.some(t => t.kind === 'diff');
    const plusMenuItems = LAUNCHER_KINDS.filter(k => !(k === 'diff' && diffOpen));

    // Folder toggle button state
    const folderVisible = fileFolderLayout.mode !== 'file-only';
    const folderToggleTitle = folderVisible ? 'Hide folder pane' : 'Show folder pane';

    const handleFolderToggle = useCallback(() => {
        if (fileFolderLayout.mode === 'file-only') {
            dispatch({ type: 'RESTORE_FILE_FOLDER_SPLIT' });
        } else {
            dispatch({ type: 'SET_FILE_FOLDER_VIEW_MODE', mode: 'file-only' });
        }
    }, [dispatch, fileFolderLayout.mode]);

    const handleOpenFileDialog = useCallback(() => {
        const folder = getDesktop()?.folder;
        void (async () => {
            if (folder?.pickFile) {
                const result = await folder.pickFile();
                if (result?.ok && result.path) {
                    // Assign the picked file to the current Files module tab.
                    dispatch({ type: 'OPEN_FILE_IN_FILES_TAB', path: result.path });
                }
                return;
            }
            // Older shell builds without a file picker: fall back to folder pick.
            if (folder?.pickFolder) await folder.pickFolder();
        })();
    }, [dispatch]);

    const handleLauncherClick = useCallback((kind: RightSidebarTabKind) => {
        dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind });
    }, [dispatch]);

    const handlePlusMenuSelect = useCallback((kind: RightSidebarTabKind) => {
        // '+' creates a new module instance (Diff stays singleton in the helper).
        dispatch({ type: 'CREATE_RIGHT_SIDEBAR_TAB', kind });
        setPlusMenuOpen(false);
    }, [dispatch]);

    const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>, tabId: string) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            dispatch({ type: 'ACTIVATE_RIGHT_SIDEBAR_TAB', tabId });
        }
    }, [dispatch]);

    // Breadcrumb segments (leading, flexible portion of the Files toolbar)
    const breadcrumbSegments = parseBreadcrumb(activeFilePath);

    const plusMenu = plusMenuOpen ? (
        <div className="right-sidebar-plus-menu" role="menu">
            {plusMenuItems.map(kind => (
                <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className="right-sidebar-plus-menu-item"
                    onClick={() => handlePlusMenuSelect(kind)}
                >
                    {TAB_KIND_ICONS[kind]()}
                    <span>{RIGHT_SIDEBAR_TAB_TITLES[kind]}</span>
                </button>
            ))}
        </div>
    ) : null;

    // -----------------------------------------------------------------------
    // Empty state: no open tabs
    // -----------------------------------------------------------------------
    if (!effectiveRightOpen || openTabs.length === 0) {
        // When sidebar is open but has no tabs, show empty state
        if (rp.open && openTabs.length === 0) {
            return (
                <aside className="right-panel" aria-label="Right sidebar">
                    <PanelResizer direction="horizontal" onDelta={handleWidthDelta} onEnd={handleWidthEnd} />
                    <div className="right-panel-shell">
                        <div className="right-panel-toolbar">
                            <button
                                type="button"
                                className="right-panel-close"
                                aria-label="Close right sidebar"
                                title="Close"
                                onClick={() => dispatch({ type: 'SET_RIGHT_OPEN', open: false })}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                        <div className="right-panel-body is-single-panel">
                            <div className="right-sidebar-empty-state" aria-label="No open tabs">
                                <div className="right-sidebar-empty-plus-wrap" ref={plusMenuRef}>
                                    <button
                                        type="button"
                                        className="right-sidebar-empty-plus"
                                        aria-label="Open panel tab"
                                        aria-haspopup="menu"
                                        aria-expanded={plusMenuOpen}
                                        title="Open panel tab"
                                        onClick={() => setPlusMenuOpen(v => !v)}
                                    >
                                        <PlusIcon />
                                    </button>
                                    {plusMenu}
                                </div>
                            </div>
                        </div>
                    </div>
                </aside>
            );
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Normal state: launcher row + open tab strip + body
    // -----------------------------------------------------------------------
    return (
        <aside className="right-panel" aria-label="Right sidebar">
            <PanelResizer direction="horizontal" onDelta={handleWidthDelta} onEnd={handleWidthEnd} />
            <div className="right-panel-shell">
                {/* --- Launcher button row (current-style controls, CEO hidden) --- */}
                <div className="right-launcher-row" aria-label="Panel launchers">
                    <div className="right-launcher-group">
                        {LAUNCHER_KINDS.map(kind => (
                            <button
                                key={kind}
                                type="button"
                                className={`right-launcher-button${activeRightTabKind === kind ? ' is-active' : ''}`}
                                aria-label={RIGHT_SIDEBAR_TAB_TITLES[kind]}
                                aria-pressed={activeRightTabKind === kind}
                                title={RIGHT_SIDEBAR_TAB_TITLES[kind]}
                                onClick={() => handleLauncherClick(kind)}
                            >
                                {TAB_KIND_ICONS[kind]()}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        className="right-panel-close"
                        aria-label="Close right sidebar"
                        title="Close"
                        onClick={() => dispatch({ type: 'SET_RIGHT_OPEN', open: false })}
                    >
                        <CloseIcon />
                    </button>
                </div>

                {/* --- Open tab strip: equal-width module tabs + fixed '+' --- */}
                <div className="right-sidebar-tab-strip" data-density={density}>
                    <div className="right-sidebar-tabs" role="tablist" aria-label="Open panel tabs">
                        {openTabs.map(tab => {
                            const isActive = tab.id === activeTabId;
                            const Icon = TAB_KIND_ICONS[tab.kind];
                            const display = getRightSidebarTabDisplay(tab);
                            return (
                                <div
                                    key={tab.id}
                                    role="tab"
                                    tabIndex={0}
                                    className={`right-sidebar-tab${isActive ? ' is-active' : ''}`}
                                    aria-selected={isActive}
                                    aria-label={display.ariaLabel}
                                    title={display.title}
                                    onClick={() => dispatch({ type: 'ACTIVATE_RIGHT_SIDEBAR_TAB', tabId: tab.id })}
                                    onKeyDown={event => handleTabKeyDown(event, tab.id)}
                                >
                                    <Icon />
                                    <span className="right-sidebar-tab-label">{display.visibleLabel}</span>
                                    <button
                                        type="button"
                                        className="right-sidebar-tab-close"
                                        aria-label={`Close ${display.ariaLabel}`}
                                        title={`Close ${display.visibleLabel}`}
                                        onClick={event => {
                                            event.stopPropagation();
                                            dispatch({ type: 'CLOSE_RIGHT_SIDEBAR_TAB', tabId: tab.id });
                                        }}
                                    >
                                        <TabCloseIcon />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <div className="right-sidebar-plus-wrap" ref={plusMenuRef}>
                        <button
                            type="button"
                            className="right-sidebar-plus"
                            aria-label="Open panel tab"
                            aria-haspopup="menu"
                            aria-expanded={plusMenuOpen}
                            title="Open panel tab"
                            onClick={() => setPlusMenuOpen(v => !v)}
                        >
                            <PlusIcon />
                        </button>
                        {plusMenu}
                    </div>
                </div>

                {/* --- Files tab one-line toolbar (only when a Files tab is active) --- */}
                {/*
                    Single horizontal line: flexible breadcrumb on the left, then
                    the Open file action and the far-right folder toggle. No inner
                    file-tab row, no inner '+', no tab-in-tab. Open file and the
                    folder button never wrap or get pushed out; the breadcrumb
                    truncates (middle segments first, final file name last).
                */}
                {activeRightTabKind === 'files' && (
                    <div className="right-files-chrome" aria-label="Files tab chrome">
                        <div className="right-files-toolbar">
                            <nav className="right-breadcrumb" aria-label="File path breadcrumb">
                                {breadcrumbSegments.map((seg, i) => {
                                    const isLast = i === breadcrumbSegments.length - 1;
                                    return (
                                        <span className="right-breadcrumb-item" key={i}>
                                            {i > 0 && <ChevronSep />}
                                            <span
                                                className={`right-breadcrumb-segment${isLast ? ' is-final' : ''}`}
                                                title={seg}
                                            >
                                                {seg}
                                            </span>
                                        </span>
                                    );
                                })}
                            </nav>
                            {props.onLoadProjectFolder && (
                                <button
                                    type="button"
                                    className="right-files-load-folder"
                                    title="Load project folder"
                                    disabled={props.loadProjectFolderDisabled === true}
                                    onClick={props.onLoadProjectFolder}
                                >
                                    불러오기
                                </button>
                            )}
                            <button
                                type="button"
                                className="right-files-open-file"
                                title="Open file"
                                onClick={handleOpenFileDialog}
                            >
                                Open file
                            </button>
                            <button
                                type="button"
                                className="right-files-folder-toggle"
                                aria-pressed={folderVisible}
                                title={folderToggleTitle}
                                onClick={handleFolderToggle}
                            >
                                <FolderToggleIcon />
                            </button>
                        </div>
                    </div>
                )}

                {/* --- Tab body: only the ACTIVE tab is mounted.
                     Keep-alive stacking is deliberately avoided: Electron
                     webviews composite out-of-process, so a hidden mounted
                     webview can still cover the window and swallow input.
                     Per-tab state (file path, folder session, page url) lives
                     in tab metadata and restores on remount. --- */}
                <div className="right-panel-body is-single-panel">
                    {activeTab && (
                        <div
                            key={activeTab.id}
                            className="right-sub-panel"
                            aria-label={getRightSidebarTabDisplay(activeTab).ariaLabel}
                        >
                            <div className="right-sub-content">
                                <PanelErrorBoundary label={RIGHT_SIDEBAR_TAB_TITLES[activeTab.kind]}>
                                    {props.renderPanel(activeTab.kind, activeTab)}
                                </PanelErrorBoundary>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </aside>
    );
}
