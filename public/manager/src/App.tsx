import { useEffect, useMemo, useState } from 'react';
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
import { Workbench } from './components/Workbench';
import { WorkbenchHeader } from './components/WorkbenchHeader';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { InstancePreview } from './InstancePreview';
import { NotesSidebar } from './notes/NotesSidebar';
import { NotesWorkspace } from './notes/NotesWorkspace';
import { useDashboardRegistry } from './hooks/useDashboardRegistry';
import { useDashboardView } from './hooks/useDashboardView';
import { useActivityUnread } from './hooks/useActivityUnread';
import { useTheme } from './hooks/useTheme';
import { useCommandPalette } from './hooks/useCommandPalette';
import { useInstanceLabelEditor } from './hooks/useInstanceLabelEditor';
import { useInstanceMessageEvents } from './hooks/useInstanceMessageEvents';
import { useManagerEvents } from './hooks/useManagerEvents';
import { formatUptime, instanceLabel } from './instance-label';
import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardInstanceStatus,
    DashboardLifecycleAction,
    DashboardNotesViewMode,
    DashboardProfile,
    DashboardScanResult,
    DashboardSidebarMode,
} from './types';

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
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
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
    const activityUnread = useActivityUnread({
        events: [...managerEvents.events, ...messageActivity.events],
        activityDockCollapsed: view.activityDockCollapsed,
        setActivityDockCollapsed: view.setActivityDockCollapsed,
        saveUi,
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

    async function load(nextShowHidden = showHidden): Promise<void> {
        setLoading(true);
        setError(null);
        try {
            const result = await fetchInstances(nextShowHidden);
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
                view.setSidebarMode(ui.sidebarMode);
                view.setNotesSelectedPath(ui.notesSelectedPath);
                view.setNotesViewMode(ui.notesViewMode);
                view.setNotesWordWrap(ui.notesWordWrap);
                view.setNotesTreeWidth(ui.notesTreeWidth);
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
        if (!hydrated) return;
        await registry.save({ ui });
    }

    const profiles = useMemo(() => data?.manager.profiles || [], [data]);
    const effectiveProfileIds = useMemo(() => {
        const known = new Set(profiles.map(profile => profile.profileId));
        return activeProfileIds.filter(profileId => known.has(profileId));
    }, [activeProfileIds, profiles]);
    const profileCounts = useMemo(() => {
        return instances.reduce((acc, instance) => {
            if (instance.profileId) acc[instance.profileId] = (acc[instance.profileId] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
    }, [instances]);
    const summary = useMemo(() => {
        return instances.reduce((acc, instance) => {
            acc.total += 1;
            acc[instance.status] = (acc[instance.status] || 0) + 1;
            return acc;
        }, { total: 0 } as Record<string, number>);
    }, [instances]);

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

    function toggleProfile(profileId: string): void {
        const next = activeProfileIds.includes(profileId)
            ? activeProfileIds.filter(id => id !== profileId)
            : [...activeProfileIds, profileId];
        setActiveProfileIds(next);
        void registry.save({ activeProfileFilter: next });
    }

    const selectedInstance = useMemo(() => {
        if (view.selectedPort == null) return filtered.find(instance => instance.ok) || null;
        return instances.find(instance => instance.port === view.selectedPort) || null;
    }, [filtered, instances, view.selectedPort]);

    useEffect(() => {
        if (view.activeDetailTab !== 'preview') return;
        if (view.selectedPort == null) return;
        if (!selectedInstance?.ok) return;
        if (selectedInstance.port !== view.selectedPort) return;
        activityUnread.markPortSeen(selectedInstance.port);
    }, [messageActivity.events, managerEvents.events, selectedInstance, view.activeDetailTab, view.selectedPort]);

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
        view.setActiveDetailTab(tab);
        if (tab === 'preview') {
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
        view.setSidebarMode(mode); void saveUi({ sidebarMode: mode });
    }

    function handleNotesSelectedPathChange(path: string | null): void {
        view.setNotesSelectedPath(path); void saveUi({ notesSelectedPath: path });
    }

    function handleNotesViewModeChange(mode: DashboardNotesViewMode): void {
        view.setNotesViewMode(mode); void saveUi({ notesViewMode: mode });
    }

    function handleNotesWordWrapChange(value: boolean): void {
        view.setNotesWordWrap(value); void saveUi({ notesWordWrap: value });
    }

    function handleNotesTreeWidthChange(value: number): void {
        view.setNotesTreeWidth(value); void saveUi({ notesTreeWidth: value });
    }

    async function handleLifecycle(action: DashboardLifecycleAction, instance: DashboardInstance): Promise<void> {
        const lifecycle = instance.lifecycle;
        if (!lifecycle) return;
        if ((action === 'stop' || action === 'restart') && !window.confirm(`${action} :${instance.port}?`)) {
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
                || (action === 'start' ? 'online' : action === 'stop' ? 'offline' : 'restart-detected');
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

    const workbenchHeader = (
        <WorkbenchHeader
            instance={selectedInstance}
            previewEnabled={previewEnabled}
            onPreviewEnabledChange={setPreviewEnabled}
            onPreviewRefresh={() => setPreviewRefreshKey(key => key + 1)}
        />
    );

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
            }}
            onRegistryPatch={(port, patch) => {
                void registry.save({ instances: { [String(port)]: patch } }).then(() => load());
            }}
        />
    );

    return (
        <>
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
                        navigator={(
                            <>
                                <SidebarRail onlineCount={summary.online || 0} collapsed={view.sidebarCollapsed} mode={view.sidebarMode} onModeChange={handleSidebarModeChange} onToggleSidebar={handleSidebarToggle} />
                                <div id="manager-sidebar-list" className="manager-sidebar-list">
                                    {view.sidebarMode === 'notes' ? (
                                        <NotesSidebar selectedPath={view.notesSelectedPath} dirtyPath={notesDirtyPath} treeWidth={view.notesTreeWidth} onSelectedPathChange={handleNotesSelectedPathChange} />
                                    ) : (
                                        <InstanceNavigator active={selectedInstance} hiddenCount={instances.filter(instance => instance.hidden).length} collapsed={view.sidebarCollapsed}>
                                            {instanceListContent}
                                        </InstanceNavigator>
                                    )}
                                </div>
                            </>
                        )}
                        workbench={(
                            <>
                                {lifecycleMessage && <section className="state lifecycle-state">{lifecycleMessage}</section>}
                                {view.sidebarMode === 'notes' ? (
                                    <NotesWorkspace selectedPath={view.notesSelectedPath} viewMode={view.notesViewMode} wordWrap={view.notesWordWrap} treeWidth={view.notesTreeWidth} onSelectedPathChange={handleNotesSelectedPathChange} onDirtyPathChange={setNotesDirtyPath} onViewModeChange={handleNotesViewModeChange} onWordWrapChange={handleNotesWordWrapChange} onTreeWidthChange={handleNotesTreeWidthChange} />
                                ) : (
                                    <Workbench mode={view.activeDetailTab} onModeChange={handleTabChange} header={workbenchHeader} overview={detailContent('overview')} preview={(
                                        <InstancePreview instance={selectedInstance} data={data} enabled={previewEnabled} refreshKey={previewRefreshKey} theme={theme.resolved} />
                                    )} logs={detailContent('logs')} settings={detailContent('settings')} />
                                )}
                            </>
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
                        mobileNav={(
                            <MobileNav
                                activeTab={view.activeDetailTab}
                                onOpenInstances={() => view.setDrawerOpen(true)}
                                onSelectTab={handleTabChange}
                                onToggleActivity={activityUnread.openAndMarkSeen}
                            />
                        )}
                        drawer={(
                            <InstanceDrawer
                                open={view.drawerOpen}
                                profileFilters={profileChipStrip(profiles)}
                                onClose={() => view.setDrawerOpen(false)}
                            >
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
        </>
    );
}
