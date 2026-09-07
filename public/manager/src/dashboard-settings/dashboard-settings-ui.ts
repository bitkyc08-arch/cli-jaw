import type { useDashboardView } from '../hooks/useDashboardView';
import { cloneNotesGraphSettings, DEFAULT_NOTES_GRAPH_SETTINGS } from '../notes/graph/notes-graph-settings';
import type { DashboardRegistryUi, DashboardUiTheme } from '../types';

type DashboardViewState = ReturnType<typeof useDashboardView>;

export function dashboardSettingsUiFromView(
    view: DashboardViewState,
    uiTheme: DashboardUiTheme
): DashboardRegistryUi {
    return {
        selectedPort: view.selectedPort,
        selectedTab: view.activeDetailTab,
        instanceSettingsOpen: view.instanceSettingsOpen,
        sidebarCollapsed: view.sidebarCollapsed,
        activityDockCollapsed: view.activityDockCollapsed,
        activityDockHeight: view.activityDockHeight,
        activitySeenAt: null,
        activitySeenByPort: {},
        uiTheme,
        locale: view.locale,
        sidebarMode: view.sidebarMode,
        notesSelectedPath: view.notesSelectedPath,
        notesViewMode: view.notesViewMode,
        notesAuthoringMode: view.notesAuthoringMode,
        notesWordWrap: view.notesWordWrap,
        notesVimMode: view.notesVimMode,
        notesTreeWidth: view.notesTreeWidth,
        notesGraphSettings: view.notesGraphSettings ?? cloneNotesGraphSettings(DEFAULT_NOTES_GRAPH_SETTINGS),
        showLatestActivityTitles: view.showLatestActivityTitles,
        showInlineLabelEditor: view.showInlineLabelEditor,
        showSidebarRuntimeLine: view.showSidebarRuntimeLine,
        showSelectedRowActions: view.showSelectedRowActions,
        dashboardShortcutsEnabled: view.dashboardShortcutsEnabled,
        dashboardShortcutKeymap: view.dashboardShortcutKeymap,
        diffRootPolicy: view.diffRootPolicy,
        diffPinnedRootByPort: view.diffPinnedRootByPort,
        diffRecentRepoRoots: view.diffRecentRepoRoots,
        diffDefaultMode: view.diffDefaultMode,
        diffBaseRef: view.diffBaseRef,
        diffIncludeUntracked: view.diffIncludeUntracked,
        rightFolderRootPath: view.rightFolderRootPath,
    };
}
