import { useState } from 'react';
import { DEFAULT_MANAGER_SHORTCUT_KEYMAP, normalizeManagerShortcutKeymap } from '../manager-shortcuts';
import type { DashboardDetailTab, DashboardDiffMode, DashboardDiffRootPolicy, DashboardLocale, DashboardNotesAuthoringMode, DashboardNotesGraphSettings, DashboardNotesViewMode, DashboardShortcutKeymap, DashboardSidebarMode, DashboardViewMode } from '../types';

export function useDashboardView() {
    const [selectedPort, setSelectedPort] = useState<number | null>(null);
    const [activeDetailTab, setActiveDetailTab] = useState<DashboardDetailTab>('overview');
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
