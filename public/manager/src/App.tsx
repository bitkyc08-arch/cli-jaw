import { useEffect, useMemo, useState } from 'react';
import { fetchInstances, runLifecycleAction } from './api';
import { ActivityDock } from './components/ActivityDock';
import { CommandBar } from './components/CommandBar';
import { InstanceDetailPanel } from './components/InstanceDetailPanel';
import { InstanceDrawer } from './components/InstanceDrawer';
import { InstanceGroups } from './components/InstanceGroups';
import { ManagerShell } from './components/ManagerShell';
import { MobileNav } from './components/MobileNav';
import { SidebarRail } from './components/SidebarRail';
import { useDashboardView } from './hooks/useDashboardView';
import type {
    DashboardInstance,
    DashboardInstanceStatus,
    DashboardLifecycleAction,
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
    return instance.instanceId || instance.homeDisplay || `port-${instance.port}`;
}

export function App() {
    const [data, setData] = useState<DashboardScanResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<'all' | DashboardInstanceStatus>('all');
    const [customHome, setCustomHome] = useState('');
    const [lifecycleBusyPort, setLifecycleBusyPort] = useState<number | null>(null);
    const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
    const view = useDashboardView();

    async function load(): Promise<void> {
        setLoading(true);
        setError(null);
        try {
            setData(await fetchInstances());
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void load();
    }, []);

    const instances = data?.instances || [];
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
            ].some(value => String(value || '').toLowerCase().includes(needle));
        });
    }, [instances, query, status]);

    const selectedInstance = useMemo(() => {
        if (view.selectedPort == null) return filtered.find(instance => instance.ok) || null;
        return instances.find(instance => instance.port === view.selectedPort) || null;
    }, [filtered, instances, view.selectedPort]);

    function handlePreview(instance: DashboardInstance): void {
        view.setSelectedPort(instance.port);
        view.setActiveDetailTab('preview');
        view.setPreviewEnabled(true);
        view.setDrawerOpen(false);
    }

    function handleSelectInstance(instance: DashboardInstance): void {
        view.setSelectedPort(instance.port);
        view.setActiveDetailTab('overview');
        view.setDrawerOpen(false);
    }

    async function handleLifecycle(action: DashboardLifecycleAction, instance: DashboardInstance): Promise<void> {
        const lifecycle = instance.lifecycle;
        if (!lifecycle) return;
        if ((action === 'stop' || action === 'restart') && !window.confirm(`${action} :${instance.port}?`)) {
            return;
        }
        setLifecycleBusyPort(instance.port);
        setLifecycleMessage(null);
        try {
            const home = action === 'start' ? customHome : undefined;
            const result = await runLifecycleAction(action, instance.port, home);
            setLifecycleMessage(result.message);
            await load();
            view.setSelectedPort(instance.port);
        } catch (err) {
            setLifecycleMessage((err as Error).message);
        } finally {
            setLifecycleBusyPort(null);
        }
    }

    const instanceList = (
        <InstanceGroups
            instances={filtered}
            selectedPort={selectedInstance?.port || null}
            lifecycleBusyPort={lifecycleBusyPort}
            getLabel={instanceLabel}
            formatUptime={formatUptime}
            onSelect={handleSelectInstance}
            onPreview={handlePreview}
            onLifecycle={(action, instance) => void handleLifecycle(action, instance)}
        />
    );

    return (
        <ManagerShell
            rail={(
                <SidebarRail
                    onlineCount={summary.online || 0}
                    onSelectInstances={() => view.setDrawerOpen(true)}
                    onSelectPreview={() => view.setActiveDetailTab('preview')}
                    onSelectActivity={() => view.setActivityDockCollapsed(false)}
                />
            )}
            commandBar={(
                <CommandBar
                    query={query}
                    status={status}
                    customHome={customHome}
                    loading={loading}
                    summary={summary}
                    manager={data?.manager || null}
                    onQueryChange={setQuery}
                    onStatusChange={setStatus}
                    onCustomHomeChange={setCustomHome}
                    onRefresh={() => void load()}
                    onOpenDrawer={() => view.setDrawerOpen(true)}
                />
            )}
            list={(
                <>
                    {error && <section className="state error-state">Scan failed: {error}</section>}
                    {!error && loading && <section className="state">Scanning local Jaw instances...</section>}
                    {!error && instanceList}
                </>
            )}
            detail={(
                <>
                    {lifecycleMessage && <section className="state lifecycle-state">{lifecycleMessage}</section>}
                    <InstanceDetailPanel
                        instance={selectedInstance}
                        data={data}
                        activeTab={view.activeDetailTab}
                        previewMode={view.previewMode}
                        previewEnabled={view.previewEnabled}
                        onTabChange={view.setActiveDetailTab}
                        onPreviewModeChange={view.setPreviewMode}
                        onPreviewEnabledChange={view.setPreviewEnabled}
                    />
                </>
            )}
            activity={(
                <ActivityDock
                    collapsed={view.activityDockCollapsed}
                    height={view.activityDockHeight}
                    loading={loading}
                    error={error}
                    lifecycleMessage={lifecycleMessage}
                    selectedInstance={selectedInstance}
                    previewMode={view.previewMode}
                    onToggle={() => view.setActivityDockCollapsed(!view.activityDockCollapsed)}
                    onHeightChange={view.setActivityDockHeight}
                />
            )}
            activityHeight={view.activityDockCollapsed ? 48 : view.activityDockHeight}
            mobileNav={(
                <MobileNav
                    activeTab={view.activeDetailTab}
                    onOpenInstances={() => view.setDrawerOpen(true)}
                    onSelectTab={view.setActiveDetailTab}
                    onToggleActivity={() => view.setActivityDockCollapsed(!view.activityDockCollapsed)}
                />
            )}
            drawer={(
                <InstanceDrawer open={view.drawerOpen} onClose={() => view.setDrawerOpen(false)}>
                    {instanceList}
                </InstanceDrawer>
            )}
        />
    );
}
