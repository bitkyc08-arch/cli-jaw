import { useEffect, useMemo, useState } from 'react';
import { fetchInstances, fetchInstanceStatus, runLifecycleAction } from './api';
import { pollUntilSettled } from './lifecycle-poll';
import { ActivityDock } from './components/ActivityDock';
import { CommandBar } from './components/CommandBar';
import { CommandPalette } from './components/CommandPalette';
import { InstanceDetailPanel } from './components/InstanceDetailPanel';
import { InstanceDrawer } from './components/InstanceDrawer';
import { InstanceGroups } from './components/InstanceGroups';
import { EmptyNavigator } from './components/EmptyNavigator';
import { InstanceNavigator } from './components/InstanceNavigator';
import { ManagerShell } from './components/ManagerShell';
import { MobileNav } from './components/MobileNav';
import { ProfileChip } from './components/ProfileChip';
import { SidebarRail } from './components/SidebarRail';
import { Workbench } from './components/Workbench';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { InstancePreview } from './InstancePreview';
import { useDashboardRegistry } from './hooks/useDashboardRegistry';
import { useDashboardView } from './hooks/useDashboardView';
import { useTheme, syncThemeFromRegistry } from './hooks/useTheme';
import { useCommandPalette } from './hooks/useCommandPalette';
import { useManagerEvents } from './hooks/useManagerEvents';
import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardInstanceStatus,
    DashboardLifecycleAction,
    DashboardProfile,
    DashboardScanResult,
} from './types';

function formatUptime(seconds: number | null): string {
    if (seconds == null) return 'n/a';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 1) return `${Math.round(seconds)}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 1) return `${minutes}m`;
    return `${hours}h ${minutes % 60}m`;
}

function instanceLabel(instance: DashboardInstance): string {
    return instance.label || instance.instanceId || instance.homeDisplay || `port-${instance.port}`;
}

export function App() {
    const [data, setData] = useState<DashboardScanResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<'all' | DashboardInstanceStatus>('all');
    const [customHome, setCustomHome] = useState('');
    const [showHidden, setShowHidden] = useState(false);
    const [scanFromInput, setScanFromInput] = useState('');
    const [scanCountInput, setScanCountInput] = useState('');
    const [hydrated, setHydrated] = useState(false);
    const [lifecycleBusyPort, setLifecycleBusyPort] = useState<number | null>(null);
    const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
    const [transitioningPort, setTransitioningPort] = useState<number | null>(null);
    const [transitionAction, setTransitionAction] = useState<DashboardLifecycleAction | null>(null);
    const [activeProfileIds, setActiveProfileIds] = useState<string[]>([]);
    const registry = useDashboardRegistry();
    const view = useDashboardView();
    const theme = useTheme((next) => {
        if (!hydrated) return;
        void registry.save({ ui: { uiTheme: next } });
    });
    const palette = useCommandPalette();
    const managerEvents = useManagerEvents();

    function cycleTheme(): void {
        const order: ('auto' | 'light' | 'dark')[] = ['auto', 'light', 'dark'];
        const next = order[(order.indexOf(theme.theme) + 1) % order.length];
        theme.setTheme(next);
    }

    function focusScanRange(): void {
        const target = document.querySelector('.scan-range-control');
        if (target instanceof HTMLElement) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const firstInput = target.querySelector('input');
            if (firstInput instanceof HTMLInputElement) firstInput.focus();
        }
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
            if (result.manager.registry) {
                setScanFromInput(String(result.manager.rangeFrom));
                setScanCountInput(String(result.manager.rangeTo - result.manager.rangeFrom + 1));
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
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
                setActiveProfileIds(loaded.registry.activeProfileFilter || []);
                syncThemeFromRegistry(ui.uiTheme);
                setScanFromInput(String(loaded.registry.scan.from));
                setScanCountInput(String(loaded.registry.scan.count));
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

    async function commitScanRange(fromValue = scanFromInput, countValue = scanCountInput): Promise<void> {
        const from = Number(fromValue);
        const count = Number(countValue);
        if (!Number.isInteger(from) || !Number.isInteger(count)) return;
        await registry.save({ scan: { from, count } });
        await load();
    }

    const instances = data?.instances || [];
    const profiles = useMemo(() => data?.manager.profiles || [], [data]);
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
            if (activeProfileIds.length > 0 && (!instance.profileId || !activeProfileIds.includes(instance.profileId))) return false;
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
    }, [activeProfileIds, instances, query, status]);

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

    function handlePreview(instance: DashboardInstance): void {
        view.setSelectedPort(instance.port);
        view.setActiveDetailTab('preview');
        view.setPreviewEnabled(true);
        view.setActivityDockCollapsed(true);
        view.setDrawerOpen(false);
        void saveUi({ selectedPort: instance.port, selectedTab: 'preview', activityDockCollapsed: true });
    }

    function handleSelectInstance(instance: DashboardInstance): void {
        view.setSelectedPort(instance.port);
        view.setDrawerOpen(false);
        void saveUi({ selectedPort: instance.port });
    }

    function handleTabChange(tab: DashboardDetailTab): void {
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
        const next = !view.activityDockCollapsed;
        view.setActivityDockCollapsed(next);
        void saveUi({ activityDockCollapsed: next });
    }

    function handleActivityHeight(height: number): void {
        view.setActivityDockHeight(height);
        void saveUi({ activityDockHeight: height });
    }

    async function handleLifecycle(action: DashboardLifecycleAction, instance: DashboardInstance): Promise<void> {
        const lifecycle = instance.lifecycle;
        if (!lifecycle) return;
        if ((action === 'stop' || action === 'restart') && !window.confirm(`${action} :${instance.port}?`)) {
            return;
        }
        const previousUptime = instance.uptime;
        setLifecycleBusyPort(instance.port);
        setLifecycleMessage(null);
        setTransitioningPort(instance.port);
        setTransitionAction(action);
        try {
            const home = action === 'start' ? customHome : undefined;
            const result = await runLifecycleAction(action, instance.port, home);
            setLifecycleMessage(result.message);
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

    function renderInstanceListContent(excludeActive = false) {
        const listInstances = excludeActive && selectedInstance
            ? filtered.filter(instance => instance.port !== selectedInstance.port)
            : filtered;

        const showEmpty = !error && !loading && instances.length === 0
            && !instances.some(instance => instance.hidden);

        return (
        <>
            {error && <section className="state error-state">Scan failed: {error}</section>}
            {!error && loading && <section className="state">Scanning local Jaw instances...</section>}
            {showEmpty && data?.manager && (
                <EmptyNavigator
                    rangeFrom={data.manager.rangeFrom}
                    rangeTo={data.manager.rangeTo}
                />
            )}
            {!error && !showEmpty && (
                <InstanceGroups
                    instances={listInstances}
                    selectedPort={selectedInstance?.port || null}
                    lifecycleBusyPort={lifecycleBusyPort}
                    transitioningPort={transitioningPort}
                    transitionAction={transitionAction}
                    profiles={profiles}
                    getLabel={instanceLabel}
                    formatUptime={formatUptime}
                    onSelect={handleSelectInstance}
                    onPreview={handlePreview}
                    onLifecycle={(action, instance) => void handleLifecycle(action, instance)}
                />
            )}
        </>
        );
    }

    const workbenchHeader = (
        <div className="detail-header">
            <div>
                <p className="eyebrow">Selected instance</p>
                <h2>{selectedInstance ? `:${selectedInstance.port} ${selectedInstance.instanceId || ''}`.trim() : 'No instance selected'}</h2>
                <span>{selectedInstance?.workingDir || selectedInstance?.url || 'Select an online instance to inspect it.'}</span>
            </div>
            {selectedInstance && <a className="open-link" href={selectedInstance.url} target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>Open</a>}
        </div>
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
                    status={status}
                    customHome={customHome}
                    loading={loading}
                    summary={summary}
                    manager={data?.manager || null}
                    showHidden={showHidden}
                    profiles={profiles}
                    activeProfileIds={activeProfileIds}
                    profileCounts={profileCounts}
                    registryMessage={registry.saving ? 'Saving' : registry.error}
                    scanFrom={scanFromInput}
                    scanCount={scanCountInput}
                    onQueryChange={setQuery}
                    onStatusChange={setStatus}
                    onCustomHomeChange={setCustomHome}
                    onShowHiddenChange={(value) => {
                        setShowHidden(value);
                        void load(value);
                    }}
                    onProfileToggle={toggleProfile}
                    onScanFromChange={setScanFromInput}
                    onScanCountChange={setScanCountInput}
                    onScanRangeCommit={(from, count) => void commitScanRange(from, count)}
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
                            <SidebarRail
                                onlineCount={summary.online || 0}
                                collapsed={view.sidebarCollapsed}
                                activeTab={view.activeDetailTab}
                                activityOpen={!view.activityDockCollapsed}
                                onSelectInstances={() => handleTabChange('overview')}
                                onSelectPreview={() => handleTabChange('preview')}
                                onSelectActivity={handleActivityToggle}
                                onToggleSidebar={handleSidebarToggle}
                            />
                            <div id="manager-sidebar-list" className="manager-sidebar-list">
                                <InstanceNavigator
                                    active={selectedInstance}
                                    hiddenCount={instances.filter(instance => instance.hidden).length}
                                    collapsed={view.sidebarCollapsed}
                                    busyPort={lifecycleBusyPort}
                                    getLabel={instanceLabel}
                                    formatUptime={formatUptime}
                                    onSelect={handleSelectInstance}
                                    onPreview={handlePreview}
                                    onLifecycle={(action, instance) => void handleLifecycle(action, instance)}
                                >
                                    {renderInstanceListContent(true)}
                                </InstanceNavigator>
                            </div>
                        </>
                    )}
                    workbench={(
                        <>
                            {lifecycleMessage && <section className="state lifecycle-state">{lifecycleMessage}</section>}
                            <Workbench
                                mode={view.activeDetailTab}
                                onModeChange={handleTabChange}
                                header={workbenchHeader}
                                overview={detailContent('overview')}
                                preview={(
                                    <InstancePreview
                                        instance={selectedInstance}
                                        data={data}
                                        mode={view.previewMode}
                                        previewEnabled={view.previewEnabled}
                                        onModeChange={view.setPreviewMode}
                                        onPreviewEnabledChange={view.setPreviewEnabled}
                                    />
                                )}
                                logs={detailContent('logs')}
                                settings={detailContent('settings')}
                            />
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
                            previewMode={view.previewMode}
                            registryMessage={registry.error || managerEvents.error}
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
                            onToggleActivity={() => {
                                view.setActivityDockCollapsed(false);
                                void saveUi({ activityDockCollapsed: false });
                            }}
                        />
                    )}
                    drawer={(
                        <InstanceDrawer
                            open={view.drawerOpen}
                            profileFilters={profileChipStrip(profiles)}
                            onClose={() => view.setDrawerOpen(false)}
                        >
                            {renderInstanceListContent(false)}
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
            onFocusScanRange={focusScanRange}
            onOpenSelected={openSelectedInBrowser}
            selectedInstance={selectedInstance}
        />
        </>
    );
}
