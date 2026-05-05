import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { fetchInstances, fetchInstanceStatus, runLifecycleAction } from './api';
import { pollUntilSettled } from './lifecycle-poll';
import { ActivityDock } from './components/ActivityDock';
import { CommandBar } from './components/CommandBar';
import { CommandPalette } from './components/CommandPalette';
import { InstanceDetailPanel } from './components/InstanceDetailPanel';
import { InstanceDrawer } from './components/InstanceDrawer';
import { InstanceListContent } from './components/InstanceListContent';
import { InstanceNavigator } from './components/InstanceNavigator';
import { ManagerShell } from './components/ManagerShell';
import { MobileNav } from './components/MobileNav';
import { ProfileChip } from './components/ProfileChip';
import { SidebarRail } from './components/SidebarRail';
import { HelpDrawer } from './help/HelpDrawer';
import { Workbench } from './components/Workbench';
import { WorkbenchHeader } from './components/WorkbenchHeader';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { InstancePreview } from './InstancePreview';
import { ElectronMetricsPanel } from './electron-metrics';
import { loadPreviewEnabled, savePreviewEnabled } from './lib/preview-prefs';
import { useHiddenUnload } from './lib/use-hidden-unload';
import { DashboardSettingsSidebar, type DashboardSettingsSection } from './dashboard-settings/DashboardSettingsSidebar';
import { DashboardSettingsWorkspace } from './dashboard-settings/DashboardSettingsWorkspace';
import { summarizeActivityTitleSupport } from './dashboard-settings/activity-title-support';
import { dashboardSettingsUiFromView } from './dashboard-settings/dashboard-settings-ui';
import { NotesSidebar } from './notes/NotesSidebar';
import { NotesWorkspace } from './notes/NotesWorkspace';
import { useNotesModel } from './notes/useNotesModel';
import { publishInvalidation } from './sync/invalidation-bus';
import { useInvalidationSubscription } from './sync/useInvalidationSubscription';
import { IframeBridge } from './sync/IframeBridge';
import { VisibilityBridge } from './sync/VisibilityBridge';
import { DashboardBoardSidebar } from './dashboard-board/DashboardBoardSidebar';
import { DashboardBoardWorkspace } from './dashboard-board/DashboardBoardWorkspace';
import type { BoardView } from './dashboard-board/board-view';
import { DashboardScheduleSidebar, type ScheduleGroup } from './dashboard-schedule/DashboardScheduleSidebar';
import { DashboardScheduleWorkspace } from './dashboard-schedule/DashboardScheduleWorkspace';
import { SCHEDULE_WORKSPACE_ENABLED, normalizeSidebarModeForBuild } from './dashboard-features';
import { useDashboardRegistry } from './hooks/useDashboardRegistry';
import { useDashboardView } from './hooks/useDashboardView';
import { useActivityUnread } from './hooks/useActivityUnread';
import { useTheme } from './hooks/useTheme';
import { useCommandPalette } from './hooks/useCommandPalette';
import { useInstanceLabelEditor } from './hooks/useInstanceLabelEditor';
import { useInstanceMessageEvents } from './hooks/useInstanceMessageEvents';
import { useManagerEvents } from './hooks/useManagerEvents';
import { formatUptime, instanceLabel } from './instance-label';
import { reconcileActiveProfileFilter } from './profile-filter';
import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardInstanceStatus,
    DashboardLifecycleAction,
    DashboardNotesAuthoringMode,
    DashboardNotesViewMode,
    DashboardProfile,
    DashboardScanResult,
    DashboardSidebarMode,
} from './types';

type WorkspaceSurfaceProps = {
    active: boolean;
    children: ReactNode;
};

function WorkspaceSurface(props: WorkspaceSurfaceProps) {
    return <section className={`workspace-surface${props.active ? ' is-active' : ''}`} hidden={!props.active} aria-hidden={!props.active}>{props.children}</section>;
}

export function App() {
    const [data, setData] = useState<DashboardScanResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<'all' | DashboardInstanceStatus>('all');
    const [customHome, setCustomHome] = useState('');
    const [showHidden, setShowHidden] = useState(false);
    const [hydrated, setHydrated] = useState(false);
    const [lifecycleBusyPort, setLifecycleBusyPort] = useState<number | null>(null);
    const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
    const [transitioningPort, setTransitioningPort] = useState<number | null>(null);
    const [transitionAction, setTransitionAction] = useState<DashboardLifecycleAction | null>(null);
    const [activeProfileIds, setActiveProfileIds] = useState<string[]>([]);
    const [settingsDirty, setSettingsDirty] = useState(false);
    const [notesDirtyPath, setNotesDirtyPath] = useState<string | null>(null);
    const [dashboardSettingsSection, setDashboardSettingsSection] = useState<DashboardSettingsSection>('display');
    const [boardView, setBoardView] = useState<BoardView>({ kind: 'overall' });
    const [scheduleGroup, setScheduleGroup] = useState<ScheduleGroup>('today');
    const [previewEnabled, setPreviewEnabled] = useState<boolean>(() => loadPreviewEnabled());
    const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
    const [autoUnloadNotice, setAutoUnloadNotice] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    useEffect(() => {
        savePreviewEnabled(previewEnabled);
    }, [previewEnabled]);
    useHiddenUnload({
        enabled: previewEnabled,
        onUnload: () => {
            setPreviewEnabled(false);
            setAutoUnloadNotice(true);
        },
    });
    useEffect(() => {
        if (!autoUnloadNotice) return undefined;
        if (typeof document === 'undefined') return undefined;
        if (document.hidden) return undefined;
        const timer = setTimeout(() => setAutoUnloadNotice(false), 8000);
        return () => clearTimeout(timer);
    }, [autoUnloadNotice]);
    const registry = useDashboardRegistry();
    const view = useDashboardView();
    const theme = useTheme((next) => {
        if (!hydrated) return;
        void registry.save({ ui: { uiTheme: next } });
    });
    const palette = useCommandPalette();
    const managerEvents = useManagerEvents();
    const instances = data?.instances || [];
    const messageActivity = useInstanceMessageEvents(instances);
    const labelEditor = useInstanceLabelEditor(registry.save, setData);

    const profiles = useMemo(() => data?.manager.profiles || [], [data]);
    const effectiveProfileIds = useMemo(() => {
        const known = new Set(profiles.map(profile => profile.profileId));
        return activeProfileIds.filter(profileId => known.has(profileId));
    }, [activeProfileIds, profiles]);
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return instances.filter((instance) => {
            if (status !== 'all' && instance.status !== status) return false;
            if (effectiveProfileIds.length > 0 && (!instance.profileId || !effectiveProfileIds.includes(instance.profileId))) return false;
            if (!needle) return true;
            return [
                String(instance.port),
                instance.url,
                instanceLabel(instance),
                instance.version,
                instance.workingDir,
                instance.currentCli,
                instance.currentModel,
                instance.healthReason,
                instance.label,
                instance.group,
                instance.profileId,
            ].some(value => String(value || '').toLowerCase().includes(needle));
        });
    }, [effectiveProfileIds, instances, query, status]);
    const selectedInstance = useMemo(() => {
        if (view.selectedPort == null) return filtered.find(instance => instance.ok) || null;
        return instances.find(instance => instance.port === view.selectedPort) || null;
    }, [filtered, instances, view.selectedPort]);

    // activity-unread must see the *resolved* selected port so the
    // auto-fallback instance (selectedPort == null) is also suppressed.
    const activePreviewPort = view.activeDetailTab === 'preview' && view.sidebarMode === 'instances'
        ? (selectedInstance?.port ?? null)
        : null;
    const activityUnread = useActivityUnread({
        events: [...managerEvents.events, ...messageActivity.events],
        activityDockCollapsed: view.activityDockCollapsed,
        setActivityDockCollapsed: view.setActivityDockCollapsed,
        saveUi,
        activePreviewPort,
    });

    function cycleTheme(): void {
        const order: ('auto' | 'light' | 'dark')[] = ['auto', 'light', 'dark'];
        const next = order[(order.indexOf(theme.theme) + 1) % order.length];
        theme.setTheme(next);
    }

    function openSelectedInBrowser(): void {
        if (!selectedInstance) return;
        window.open(selectedInstance.url, '_blank', 'noopener,noreferrer');
    }

    useEffect(() => {
        document.documentElement.lang = view.locale;
    }, [view.locale]);

    async function load(nextShowHidden = showHidden): Promise<void> {
        setLoading(true);
        setError(null);
        try {
            const result = await fetchInstances(nextShowHidden);
            const nextProfileIds = reconcileActiveProfileFilter(activeProfileIds, result.manager.profiles || []);
            if (nextProfileIds !== activeProfileIds) { setActiveProfileIds(nextProfileIds); void registry.save({ activeProfileFilter: nextProfileIds }); }
            setData(result);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }

    async function refreshInstance(port: number): Promise<void> {
        const instance = await fetchInstanceStatus(port);
        if (!instance) return;
        setData((current) => current ? {
            ...current,
            instances: current.instances.map(row => row.port === port ? instance : row),
        } : current);
    }

    useInvalidationSubscription('instances', () => void load(), 'app');

    useEffect(() => {
        async function initialize(): Promise<void> {
            try {
                const loaded = await registry.refresh();
                const ui = loaded.registry.ui;
                view.setSelectedPort(ui.selectedPort);
                view.setActiveDetailTab(ui.selectedTab);
                view.setSidebarCollapsed(ui.sidebarCollapsed);
                view.setActivityDockCollapsed(ui.activityDockCollapsed);
                view.setActivityDockHeight(ui.activityDockHeight);
                const sidebarMode = normalizeSidebarModeForBuild(ui.sidebarMode);
                view.setSidebarMode(sidebarMode);
                if (sidebarMode !== ui.sidebarMode) void saveUi({ sidebarMode });
                view.setNotesSelectedPath(ui.notesSelectedPath);
                view.setNotesViewMode(ui.notesViewMode);
                view.setNotesAuthoringMode(ui.notesAuthoringMode ?? 'plain');
                view.setNotesWordWrap(ui.notesWordWrap);
                view.setNotesTreeWidth(ui.notesTreeWidth);
                view.setShowLatestActivityTitles(ui.showLatestActivityTitles);
                view.setShowInlineLabelEditor(ui.showInlineLabelEditor);
                view.setShowSidebarRuntimeLine(ui.showSidebarRuntimeLine);
                view.setShowSelectedRowActions(ui.showSelectedRowActions);
                view.setLocale(ui.locale);
                activityUnread.hydrateSeenAt(ui.activitySeenAt ?? null, ui.activitySeenByPort || {});
                setActiveProfileIds(loaded.registry.activeProfileFilter || []);
                theme.syncFromRegistry(ui.uiTheme);
            } finally {
                setHydrated(true);
                await load();
            }
        }
        void initialize();
    }, []);

    async function saveUi(ui: Parameters<typeof registry.save>[0]['ui']): Promise<void> {
        if (!hydrated || ui === undefined) return;
        await registry.save({ ui });
    }

    const profileCounts = useMemo(() => {
        return instances.reduce((acc, instance) => {
            if (instance.profileId) acc[instance.profileId] = (acc[instance.profileId] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
    }, [instances]);
    const summary = useMemo(() => {
        return instances.reduce((acc, instance) => {
            acc['total'] += 1;
            acc[instance.status] = (acc[instance.status] || 0) + 1;
            return acc;
        }, { total: 0 } as Record<string, number>);
    }, [instances]);

    function toggleProfile(profileId: string): void {
        const next = activeProfileIds.includes(profileId)
            ? activeProfileIds.filter(id => id !== profileId)
            : [...activeProfileIds, profileId];
        setActiveProfileIds(next);
        void registry.save({ activeProfileFilter: next });
    }

    function canLeaveDirtySettings(): boolean {
        if (view.activeDetailTab !== 'settings' || !settingsDirty) return true;
        return window.confirm('Discard unsaved Settings changes?');
    }

    function handlePreview(instance: DashboardInstance): void {
        if (!canLeaveDirtySettings()) return;
        setSettingsDirty(false);
        activityUnread.markPortSeen(instance.port);
        view.setSelectedPort(instance.port);
        view.setActiveDetailTab('preview');
        view.setActivityDockCollapsed(true);
        view.setDrawerOpen(false);
        void saveUi({ selectedPort: instance.port, selectedTab: 'preview', activityDockCollapsed: true });
    }

    function handleSelectInstance(instance: DashboardInstance): void {
        if (!canLeaveDirtySettings()) return;
        setSettingsDirty(false);
        activityUnread.markPortSeen(instance.port);
        view.setSelectedPort(instance.port);
        view.setDrawerOpen(false);
        void saveUi({ selectedPort: instance.port });
    }

    function handleTabChange(tab: DashboardDetailTab): void {
        if (tab !== 'settings' && !canLeaveDirtySettings()) return;
        if (tab !== 'settings') setSettingsDirty(false);
        if (view.activeDetailTab === 'preview' && tab !== 'preview') {
            const port = view.selectedPort;
            if (port != null) activityUnread.markPortSeen(port);
        }
        view.setActiveDetailTab(tab);
        if (tab === 'preview') {
            const port = view.selectedPort;
            if (port != null) activityUnread.markPortSeen(port);
            view.setActivityDockCollapsed(true);
            void saveUi({ selectedTab: tab, activityDockCollapsed: true });
            return;
        }
        void saveUi({ selectedTab: tab });
    }

    function handleSidebarToggle(): void {
        const next = !view.sidebarCollapsed;
        view.setSidebarCollapsed(next);
        void saveUi({ sidebarCollapsed: next });
    }

    function handleActivityToggle(): void {
        if (view.activityDockCollapsed) {
            activityUnread.openAndMarkSeen();
            return;
        }
        activityUnread.closeAndPersistSeen();
    }

    function handleActivityHeight(height: number): void {
        view.setActivityDockHeight(height);
        void saveUi({ activityDockHeight: height });
    }

    function handleSidebarModeChange(mode: DashboardSidebarMode): void {
        if (view.sidebarMode === 'instances' && mode !== 'instances' && view.activeDetailTab === 'preview') {
            const port = view.selectedPort;
            if (port != null) activityUnread.markPortSeen(port);
        }
        const sidebarMode = normalizeSidebarModeForBuild(mode);
        view.setSidebarMode(sidebarMode); void saveUi({ sidebarMode });
    }

    function handleNotesSelectedPathChange(path: string | null): void {
        view.setNotesSelectedPath(path); void saveUi({ notesSelectedPath: path });
    }

    function handleNotesViewModeChange(mode: DashboardNotesViewMode): void {
        view.setNotesViewMode(mode); void saveUi({ notesViewMode: mode });
    }

    function handleNotesAuthoringModeChange(mode: DashboardNotesAuthoringMode): void {
        view.setNotesAuthoringMode(mode); void saveUi({ notesAuthoringMode: mode });
    }

    function handleNotesWordWrapChange(value: boolean): void {
        view.setNotesWordWrap(value); void saveUi({ notesWordWrap: value });
    }

    function handleNotesTreeWidthChange(value: number): void {
        view.setNotesTreeWidth(value); void saveUi({ notesTreeWidth: value });
    }

    const notesModel = useNotesModel({
        active: view.sidebarMode === 'notes',
        selectedPath: view.notesSelectedPath,
        onSelectedPathChange: handleNotesSelectedPathChange,
    });

    function handleDashboardSettingsPatch(ui: NonNullable<Parameters<typeof saveUi>[0]>): void {
        if (ui.showLatestActivityTitles !== undefined) view.setShowLatestActivityTitles(ui.showLatestActivityTitles);
        if (ui.showInlineLabelEditor !== undefined) view.setShowInlineLabelEditor(ui.showInlineLabelEditor);
        if (ui.showSidebarRuntimeLine !== undefined) view.setShowSidebarRuntimeLine(ui.showSidebarRuntimeLine);
        if (ui.showSelectedRowActions !== undefined) view.setShowSelectedRowActions(ui.showSelectedRowActions);
        if (ui.locale !== undefined) view.setLocale(ui.locale);
        void saveUi(ui);
    }

    async function handleLifecycle(action: DashboardLifecycleAction, instance: DashboardInstance): Promise<void> {
        const lifecycle = instance.lifecycle;
        if (!lifecycle) return;
        if (action === 'perm' && !window.confirm(`Register :${instance.port} as a persistent system service? It will auto-start on login and auto-restart on crash.`)) {
            return;
        }
        if (action === 'unperm' && !window.confirm(`Remove persistent service for :${instance.port}? The instance will stop and won't auto-start.`)) {
            return;
        }
        if (action === 'stop' && lifecycle.owner === 'service') {
            if (!window.confirm(`Stop :${instance.port}? This will also remove the persistent service.`)) return;
        } else if ((action === 'stop' || action === 'restart') && !window.confirm(`${action} :${instance.port}?`)) {
            return;
        }
        if (!canLeaveDirtySettings()) return;
        setSettingsDirty(false);
        const previousUptime = instance.uptime;
        setLifecycleBusyPort(instance.port);
        setLifecycleMessage(null);
        setTransitioningPort(instance.port);
        setTransitionAction(action);
        try {
            const home = action === 'start' ? customHome : undefined;
            const result = await runLifecycleAction(action, instance.port, home);
            const expected = result.expectedStateAfter
                || (action === 'start' || action === 'perm' ? 'online' : action === 'stop' || action === 'unperm' ? 'offline' : 'restart-detected');
            const polled = await pollUntilSettled({
                port: instance.port,
                expected,
                previousUptime,
                fetchOnce: (port, signal) => fetchInstanceStatus(port, { signal }),
            });
            if (!polled.settled) {
                setLifecycleMessage(`${result.message} (not yet reachable, refresh manually if needed)`);
            }
            await load();
            publishInvalidation({ topics: ['instances'], reason: 'instance:lifecycle', source: 'ui', sourceId: 'app' });
            view.setSelectedPort(instance.port);
        } catch (err) {
            setLifecycleMessage((err as Error).message);
        } finally {
            setLifecycleBusyPort(null);
            setTransitioningPort(null);
            setTransitionAction(null);
        }
    }

    const instanceListContent = (
        <InstanceListContent
            error={error}
            loading={loading}
            instances={instances}
            filtered={filtered}
            selectedInstance={selectedInstance}
            data={data}
            lifecycleBusyPort={lifecycleBusyPort}
            transitioningPort={transitioningPort}
            transitionAction={transitionAction}
            activityUnreadByPort={activityUnread.unreadByPort}
            latestTitleByPort={messageActivity.titlesByPort}
            busyPorts={messageActivity.busyPorts}
            showLatestActivityTitles={view.showLatestActivityTitles}
            showInlineLabelEditor={view.showInlineLabelEditor}
            showSidebarRuntimeLine={view.showSidebarRuntimeLine}
            showSelectedRowActions={view.showSelectedRowActions}
            profiles={profiles}
            getLabel={instanceLabel}
            formatUptime={formatUptime}
            onSelect={handleSelectInstance}
            onPreview={handlePreview}
            onMarkActivitySeen={activityUnread.markPortSeen}
            onInstanceLabelSave={labelEditor.saveInstanceLabel}
            onLifecycle={(action, instance) => void handleLifecycle(action, instance)}
        />
    );

    const workbenchHeader = <WorkbenchHeader instance={selectedInstance} previewEnabled={previewEnabled} onPreviewEnabledChange={setPreviewEnabled} onPreviewRefresh={() => setPreviewRefreshKey(key => key + 1)} />;
    const dashboardSettingsUi = dashboardSettingsUiFromView(view, theme.theme);
    const titleSupport = summarizeActivityTitleSupport(messageActivity.titleSupportByPort);

    const profileChipStrip = (chipProfiles: DashboardProfile[]) => chipProfiles.length > 0 ? (
        <div className="profile-chip-strip drawer-chip-strip" aria-label="Profile filters">
            {chipProfiles.map(profile => (
                <ProfileChip
                    key={profile.profileId}
                    profile={profile}
                    active={activeProfileIds.includes(profile.profileId)}
                    count={profileCounts[profile.profileId] || 0}
                    onToggle={toggleProfile}
                />
            ))}
        </div>
    ) : null;

    const detailContent = (tab: DashboardDetailTab) => (
        <InstanceDetailPanel
            instance={selectedInstance}
            data={data}
            activeTab={tab}
            onSettingsDirtyChange={setSettingsDirty}
            onSettingsSaved={() => {
                if (selectedInstance) void refreshInstance(selectedInstance.port);
                publishInvalidation({ topics: ['instances'], reason: 'instance:settings-saved', source: 'ui', sourceId: 'app' });
            }}
            onRegistryPatch={(port, patch) => {
                void registry.save({ instances: { [String(port)]: patch } }).then(() => {
                    load();
                    publishInvalidation({ topics: ['instances'], reason: 'instance:registry-patched', source: 'ui', sourceId: 'app' });
                });
            }}
        />
    );

    return (
        <>
            <IframeBridge />
            <VisibilityBridge />
            <ManagerShell
                sidebarCollapsed={view.sidebarCollapsed}
                commandBar={(
                    <CommandBar
                        query={query}
                        loading={loading}
                        onQueryChange={setQuery}
                        onRefresh={() => void load()}
                        onOpenDrawer={() => view.setDrawerOpen(true)}
                        theme={theme.theme}
                        onThemeChange={theme.setTheme}
                        onOpenPalette={palette.toggle}
                    />
                )}
                workspace={(
                    <WorkspaceLayout
                        sidebarCollapsed={view.sidebarCollapsed}
                        inspectorCollapsed={view.activityDockCollapsed}
                        inspectorHeight={view.activityDockCollapsed ? 48 : view.activityDockHeight}
                        drawerOpen={view.drawerOpen}
                        onCloseDrawer={() => view.setDrawerOpen(false)}
                        navigator={(
                            <>
                                <SidebarRail onlineCount={summary['online'] || 0} collapsed={view.sidebarCollapsed} mode={view.sidebarMode} scheduleWorkspaceEnabled={SCHEDULE_WORKSPACE_ENABLED} onModeChange={handleSidebarModeChange} onToggleSidebar={handleSidebarToggle} helpOpen={helpOpen} onToggleHelp={() => setHelpOpen(open => !open)} />
                                <div id="manager-sidebar-list" className="manager-sidebar-list">
                                    {view.sidebarMode === 'settings' ? (
                                        <DashboardSettingsSidebar activeSection={dashboardSettingsSection} locale={view.locale} onSectionChange={setDashboardSettingsSection} />
                                    ) : view.sidebarMode === 'notes' ? (
                                        <NotesSidebar tree={notesModel.tree} loading={notesModel.loading} error={notesModel.error} notesRoot={notesModel.notesRoot} selectedPath={view.notesSelectedPath} dirtyPath={notesDirtyPath} treeWidth={view.notesTreeWidth} onSelectedPathChange={handleNotesSelectedPathChange} onRefreshTree={notesModel.refresh} />
                                    ) : view.sidebarMode === 'board' ? (
                                        <DashboardBoardSidebar view={boardView} onViewChange={setBoardView} instances={instances} titlesByPort={messageActivity.titlesByPort} busyPorts={messageActivity.busyPorts} />
                                    ) : SCHEDULE_WORKSPACE_ENABLED && view.sidebarMode === 'schedule' ? (
                                        <DashboardScheduleSidebar activeGroup={scheduleGroup} onGroupChange={setScheduleGroup} />
                                    ) : (
                                        <InstanceNavigator active={selectedInstance} hiddenCount={instances.filter(instance => instance.hidden).length} collapsed={view.sidebarCollapsed}>
                                            {instanceListContent}
                                        </InstanceNavigator>
                                    )}
                                </div>
                            </>
                        )}
                        workbench={(
                            <div className="workspace-surface-stack">
                                {lifecycleMessage && (
                                    <section className="state lifecycle-state" role="status">
                                        <span>{lifecycleMessage}</span>
                                        <button
                                            type="button"
                                            className="state-dismiss"
                                            aria-label="Dismiss lifecycle message"
                                            onClick={() => setLifecycleMessage(null)}
                                        >
                                            X
                                        </button>
                                    </section>
                                )}
                                <div className="workspace-surface-layer">
                                    <WorkspaceSurface active={view.sidebarMode === 'instances'}>
                                        <Workbench mode={view.activeDetailTab} onModeChange={handleTabChange} header={workbenchHeader} overview={detailContent('overview')} preview={(
                                            <InstancePreview instance={selectedInstance} data={data} enabled={previewEnabled} refreshKey={previewRefreshKey} theme={theme.resolved} />
                                        )} logs={detailContent('logs')} settings={detailContent('settings')} />
                                    </WorkspaceSurface>
                                    <WorkspaceSurface active={view.sidebarMode === 'notes'}>
                                        <NotesWorkspace active={view.sidebarMode === 'notes'} selectedPath={view.notesSelectedPath} vaultIndex={notesModel.index} viewMode={view.notesViewMode} authoringMode={view.notesAuthoringMode} wordWrap={view.notesWordWrap} treeWidth={view.notesTreeWidth} onSelectedPathChange={handleNotesSelectedPathChange} onDirtyPathChange={setNotesDirtyPath} onViewModeChange={handleNotesViewModeChange} onAuthoringModeChange={handleNotesAuthoringModeChange} onWordWrapChange={handleNotesWordWrapChange} onTreeWidthChange={handleNotesTreeWidthChange} />
                                    </WorkspaceSurface>
                                    <WorkspaceSurface active={view.sidebarMode === 'settings'}>
                                        <DashboardSettingsWorkspace activeSection={dashboardSettingsSection} ui={dashboardSettingsUi} titleSupport={titleSupport} onUiPatch={handleDashboardSettingsPatch} />
                                    </WorkspaceSurface>
                                    <WorkspaceSurface active={view.sidebarMode === 'board'}>
                                        <DashboardBoardWorkspace active={view.sidebarMode === 'board'} view={boardView} onViewChange={setBoardView} instances={instances} selectedPort={selectedInstance?.port ?? null} titlesByPort={messageActivity.titlesByPort} busyPorts={messageActivity.busyPorts} />
                                    </WorkspaceSurface>
                                    {SCHEDULE_WORKSPACE_ENABLED ? (
                                        <>
                                            <WorkspaceSurface active={view.sidebarMode === 'schedule'}>
                                                <DashboardScheduleWorkspace active={view.sidebarMode === 'schedule'} activeGroup={scheduleGroup} busyPorts={messageActivity.busyPorts} />
                                            </WorkspaceSurface>
                                        </>
                                    ) : null}
                                </div>
                            </div>
                        )}
                        inspector={(
                            <ActivityDock
                                collapsed={view.activityDockCollapsed}
                                height={view.activityDockHeight}
                                loading={loading}
                                error={error}
                                lifecycleMessage={lifecycleMessage}
                                selectedInstance={selectedInstance}
                                registryMessage={registry.error || labelEditor.error || managerEvents.error}
                                events={managerEvents.events}
                                onToggle={handleActivityToggle}
                                onHeightChange={handleActivityHeight}
                            />
                        )}
                        mobileNav={<MobileNav activeTab={view.activeDetailTab} onOpenInstances={() => view.setDrawerOpen(true)} onSelectTab={handleTabChange} onToggleActivity={activityUnread.openAndMarkSeen} />}
                        drawer={(
                            <InstanceDrawer open={view.drawerOpen} profileFilters={profileChipStrip(profiles)} onClose={() => view.setDrawerOpen(false)}>
                                {instanceListContent}
                            </InstanceDrawer>
                        )}
                    />
                )}
                activityHeight={view.activityDockCollapsed ? 48 : view.activityDockHeight}
            />
            <CommandPalette
                open={palette.open}
                onClose={palette.close}
                instances={instances}
                getLabel={instanceLabel}
                onSelectInstance={handleSelectInstance}
                theme={theme.theme}
                onCycleTheme={cycleTheme}
                onRefresh={() => void load()}
                onToggleHidden={() => {
                    const next = !showHidden;
                    setShowHidden(next);
                    void load(next);
                }}
                showHidden={showHidden}
                onOpenSelected={openSelectedInBrowser}
                selectedInstance={selectedInstance}
            />
            <ElectronMetricsPanel onUnloadPreview={() => setPreviewEnabled(false)} />
            <HelpDrawer open={helpOpen} mode={view.sidebarMode} onClose={() => setHelpOpen(false)} />
            {autoUnloadNotice && (
                <div className="preview-auto-unload-notice" role="status">
                    Preview was unloaded after 5 minutes of inactivity. Toggle the preview switch to re-enable.
                    <button
                        type="button"
                        className="preview-auto-unload-dismiss"
                        aria-label="Dismiss preview auto-unload notice"
                        onClick={() => setAutoUnloadNotice(false)}
                    >
                        ×
                    </button>
                </div>
            )}
        </>
    );
}
