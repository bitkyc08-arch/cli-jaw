import type { useDashboardView } from '../hooks/useDashboardView';
import type { DashboardRegistryUi, DashboardUiTheme } from '../types';

type DashboardViewState = ReturnType<typeof useDashboardView>;

export function dashboardSettingsUiFromView(
    view: DashboardViewState,
    uiTheme: DashboardUiTheme
): DashboardRegistryUi {
    return {
        selectedPort: view.selectedPort,
        selectedTab: view.activeDetailTab,
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
        notesWordWrap: view.notesWordWrap,
        notesTreeWidth: view.notesTreeWidth,
        showLatestActivityTitles: view.showLatestActivityTitles,
        showInlineLabelEditor: view.showInlineLabelEditor,
        showSidebarRuntimeLine: view.showSidebarRuntimeLine,
        showSelectedRowActions: view.showSelectedRowActions,
    };
}
