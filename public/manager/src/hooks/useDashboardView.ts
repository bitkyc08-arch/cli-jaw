import { useCallback, useState } from 'react';
import type { DashboardRegistryUi } from '../types';
import { DEFAULT_MANAGER_SHORTCUT_KEYMAP, normalizeManagerShortcutKeymap } from '../manager-shortcuts';
import type { DashboardDetailTab, DashboardDiffMode, DashboardDiffRootPolicy, DashboardLocale, DashboardNotesAuthoringMode, DashboardNotesGraphSettings, DashboardNotesViewMode, DashboardShortcutKeymap, DashboardSidebarMode, DashboardViewMode } from '../types';

export function useDashboardView() {
    const [selectedPort, setSelectedPort] = useState<number | null>(null);
    const [activeDetailTab, setActiveDetailTab] = useState<DashboardDetailTab>('overview');
    const [instanceSettingsOpen, setInstanceSettingsOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [activityDockCollapsed, setActivityDockCollapsed] = useState(false);
    const [activityDockHeight, setActivityDockHeight] = useState(150);
    const [sidebarMode, setSidebarMode] = useState<DashboardSidebarMode>('instances');
    const [viewMode, setViewMode] = useState<DashboardViewMode>('jaw');
    const [notesSelectedPath, setNotesSelectedPath] = useState<string | null>(null);
    const [notesViewMode, setNotesViewMode] = useState<DashboardNotesViewMode>('raw');
    const [notesAuthoringMode, setNotesAuthoringMode] = useState<DashboardNotesAuthoringMode>('plain');
    const [notesWordWrap, setNotesWordWrap] = useState(true);
    const [notesVimMode, setNotesVimMode] = useState(false);
    const [notesTreeWidth, setNotesTreeWidth] = useState(280);
    const [notesGraphSettings, setNotesGraphSettings] = useState<DashboardNotesGraphSettings | undefined>(undefined);
    const [showLatestActivityTitles, setShowLatestActivityTitles] = useState(true);
    const [showInlineLabelEditor, setShowInlineLabelEditor] = useState(true);
    const [showSidebarRuntimeLine, setShowSidebarRuntimeLine] = useState(true);
    const [showSelectedRowActions, setShowSelectedRowActions] = useState(true);
    const [dashboardShortcutsEnabled, setDashboardShortcutsEnabled] = useState(true);
    const [dashboardShortcutKeymap, setDashboardShortcutKeymapState] = useState<DashboardShortcutKeymap>({ ...DEFAULT_MANAGER_SHORTCUT_KEYMAP });
    const [diffRootPolicy, setDiffRootPolicy] = useState<DashboardDiffRootPolicy>('project-first');
    const [diffPinnedRootByPort, setDiffPinnedRootByPort] = useState<Record<string, string>>({});
    const [diffRecentRepoRoots, setDiffRecentRepoRoots] = useState<string[]>([]);
    const [diffDefaultMode, setDiffDefaultMode] = useState<DashboardDiffMode>('unstaged');
    const [diffBaseRef, setDiffBaseRef] = useState('HEAD');
    const [diffIncludeUntracked, setDiffIncludeUntracked] = useState(true);
    const [rightFolderRootPath, setRightFolderRootPath] = useState<string | null>(null);
    const [locale, setLocale] = useState<DashboardLocale>('ko');

    function setDashboardShortcutKeymap(value: unknown): void {
        setDashboardShortcutKeymapState(normalizeManagerShortcutKeymap(value));
    }

    return {
        selectedPort,
        setSelectedPort,
        instanceSettingsOpen, setInstanceSettingsOpen,
        activeDetailTab,
        setActiveDetailTab,
        drawerOpen,
        setDrawerOpen,
        sidebarCollapsed,
        setSidebarCollapsed,
        activityDockCollapsed,
        setActivityDockCollapsed,
        activityDockHeight,
        setActivityDockHeight,
        sidebarMode,
        setSidebarMode,
        viewMode,
        setViewMode,
        notesSelectedPath,
        setNotesSelectedPath,
        notesViewMode,
        setNotesViewMode,
        notesAuthoringMode,
        setNotesAuthoringMode,
        notesWordWrap,
        setNotesWordWrap,
        notesVimMode,
        setNotesVimMode,
        notesTreeWidth,
        setNotesTreeWidth,
        notesGraphSettings,
        setNotesGraphSettings,
        showLatestActivityTitles,
        setShowLatestActivityTitles,
        showInlineLabelEditor,
        setShowInlineLabelEditor,
        showSidebarRuntimeLine,
        setShowSidebarRuntimeLine,
        showSelectedRowActions,
        setShowSelectedRowActions,
        dashboardShortcutsEnabled,
        setDashboardShortcutsEnabled,
        dashboardShortcutKeymap,
        setDashboardShortcutKeymap,
        diffRootPolicy,
        setDiffRootPolicy,
        diffPinnedRootByPort,
        setDiffPinnedRootByPort,
        diffRecentRepoRoots,
        setDiffRecentRepoRoots,
        diffDefaultMode,
        setDiffDefaultMode,
        diffBaseRef,
        setDiffBaseRef,
        diffIncludeUntracked,
        setDiffIncludeUntracked,
        rightFolderRootPath,
        setRightFolderRootPath,
        locale,
        setLocale,
    };
}

export function hydrateInstanceSettings(ui: Pick<DashboardRegistryUi, 'selectedTab'> & { instanceSettingsOpen?: unknown }) {
    return { selectedTab: ui.selectedTab === 'settings' ? 'overview' as const : ui.selectedTab,
        instanceSettingsOpen: ui.selectedTab === 'settings' || ui.instanceSettingsOpen === true };
}

type SettingsNavigation = {
    view: Pick<ReturnType<typeof useDashboardView>, 'instanceSettingsOpen' | 'activeDetailTab' |
        'setSelectedPort' | 'setInstanceSettingsOpen' | 'setSidebarMode' | 'setViewMode' | 'setDrawerOpen'>;
    selectedPort: number | null;
    settingsDirty: boolean;
    panelSettingsDirty: boolean;
    setSettingsDirty: (dirty: boolean) => void;
    clearPanelDirty: () => void;
    saveUi: (patch: Partial<DashboardRegistryUi>) => Promise<void>;
    confirmDiscard?: () => boolean;
};
export function createInstanceSettingsNavigation(args: SettingsNavigation) {
    const { view, selectedPort } = args;
    function canLeaveDirtySettings(): boolean {
        return !args.settingsDirty ||
            (args.confirmDiscard ?? (() => window.confirm('Discard unsaved Settings changes?')))();
    }
    function setInstanceSettingsOpen(open: boolean, port = selectedPort): void {
        if ((port !== selectedPort || (!open && args.panelSettingsDirty)) && !canLeaveDirtySettings()) return;
        if (port !== selectedPort) args.setSettingsDirty(false);
        else if (!open) args.clearPanelDirty();
        if (open) {
            view.setSelectedPort(port); view.setSidebarMode('instances');
            view.setViewMode('jaw'); view.setDrawerOpen(false);
        }
        view.setInstanceSettingsOpen(open);
        void args.saveUi({ instanceSettingsOpen: open,
            selectedTab: view.activeDetailTab === 'settings' ? 'overview' : view.activeDetailTab,
            ...(open ? { selectedPort: port, sidebarMode: 'instances' as const } : {}) });
    }
    return { canLeaveDirtySettings, setInstanceSettingsOpen };
}

// Both entry points may remain mounted: a clean hidden Shell cannot clear its peer.
export function settingsDirtyAfter(current: { panel: boolean; dashboard: boolean },
    entry: 'panel' | 'dashboard', dirty: boolean) {
    return { ...current, [entry]: dirty };
}
export function useSettingsDirtyState() {
    const [entries, setEntries] = useState({ panel: false, dashboard: false });
    const onSettingsDirtyChange = useCallback((entry: 'panel' | 'dashboard', dirty: boolean) => {
        setEntries(current => settingsDirtyAfter(current, entry, dirty));
    }, []);
    // SettingsShell keys its dirty notification and unmount cleanup to this callback.
    const onPanelSettingsDirtyChange = useCallback((dirty: boolean) => {
        onSettingsDirtyChange('panel', dirty);
    }, [onSettingsDirtyChange]);
    const setSettingsDirty = useCallback((dirty: boolean) => {
        setEntries({ panel: dirty, dashboard: dirty });
    }, []);
    return { settingsDirty: entries.panel || entries.dashboard, panelSettingsDirty: entries.panel, setSettingsDirty, onSettingsDirtyChange, onPanelSettingsDirtyChange };
}
