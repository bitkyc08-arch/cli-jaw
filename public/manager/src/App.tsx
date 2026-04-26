import { useEffect, useMemo, useState } from 'react';
import { fetchInstances } from './api';
import { InstancePreview } from './InstancePreview';
import type { DashboardInstance, DashboardInstanceStatus, DashboardPreviewMode, DashboardScanResult } from './types';

const STATUS_OPTIONS: Array<'all' | DashboardInstanceStatus> = ['all', 'online', 'offline', 'timeout', 'error', 'unknown'];

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

function statusClass(status: DashboardInstanceStatus): string {
    return `status status-${status}`;
}

export function App() {
    const [data, setData] = useState<DashboardScanResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<'all' | DashboardInstanceStatus>('all');
    const [selectedPort, setSelectedPort] = useState<number | null>(null);
    const [previewMode, setPreviewMode] = useState<DashboardPreviewMode>('proxy');
    const [previewEnabled, setPreviewEnabled] = useState(true);

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
        if (selectedPort == null) return filtered.find(instance => instance.ok) || null;
        return instances.find(instance => instance.port === selectedPort) || null;
    }, [filtered, instances, selectedPort]);

    return (
        <main className="dashboard-shell">
            <header className="dashboard-topbar">
                <div>
                    <p className="eyebrow">Jaw Manager</p>
                    <h1>Instance dashboard</h1>
                </div>
                <div className="topbar-meta">
                    <span>Manager {data?.manager.port || 24576}</span>
                    <span>Scan {data ? `${data.manager.rangeFrom}-${data.manager.rangeTo}` : '3457-3506'}</span>
                    <button type="button" onClick={() => void load()} disabled={loading}>
                        {loading ? 'Scanning' : 'Refresh'}
                    </button>
                </div>
            </header>

            <section className="summary-grid" aria-label="Instance summary">
                <div><span>Total</span><strong>{summary.total || 0}</strong></div>
                <div><span>Online</span><strong>{summary.online || 0}</strong></div>
                <div><span>Offline</span><strong>{summary.offline || 0}</strong></div>
                <div><span>Timeout</span><strong>{summary.timeout || 0}</strong></div>
            </section>

            <section className="toolbar" aria-label="Filters">
                <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Search port, home, CLI, model"
                    aria-label="Search instances"
                />
                <select
                    value={status}
                    onChange={event => setStatus(event.target.value as 'all' | DashboardInstanceStatus)}
                    aria-label="Filter by status"
                >
                    {STATUS_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
            </section>

            {error && <section className="state error-state">Scan failed: {error}</section>}
            {!error && loading && <section className="state">Scanning local Jaw instances...</section>}
            {!error && !loading && filtered.length === 0 && (
                <section className="state">No matching instances found.</section>
            )}

            {!error && filtered.length > 0 && (
                <section className="dashboard-layout">
                    <section className="instance-table" aria-label="Jaw instances">
                        <div className="table-head">
                            <span>Status</span>
                            <span>Instance</span>
                            <span>Runtime</span>
                            <span>Last checked</span>
                            <span>Action</span>
                        </div>
                        {filtered.map(instance => (
                            <article
                                className={`instance-row ${selectedInstance?.port === instance.port ? 'is-selected' : ''}`}
                                key={instance.port}
                            >
                                <div>
                                    <span className={statusClass(instance.status)}>{instance.status}</span>
                                    <span className="port">:{instance.port}</span>
                                </div>
                                <div>
                                    <strong>{instanceLabel(instance)}</strong>
                                    <span>{instance.workingDir || instance.url}</span>
                                </div>
                                <div>
                                    <span>{instance.currentCli || 'cli n/a'} / {instance.currentModel || 'model n/a'}</span>
                                    <span>v{instance.version || 'n/a'} · {formatUptime(instance.uptime)}</span>
                                </div>
                                <div>
                                    <span>{new Date(instance.lastCheckedAt).toLocaleTimeString()}</span>
                                    <span>{instance.healthReason || 'ok'}</span>
                                </div>
                                <div className="instance-actions">
                                    <button
                                        type="button"
                                        onClick={() => setSelectedPort(instance.port)}
                                        disabled={!instance.ok}
                                    >
                                        Preview
                                    </button>
                                    <a className="open-link" href={instance.url} target="_blank" rel="noreferrer">Open</a>
                                </div>
                            </article>
                        ))}
                    </section>

                    <InstancePreview
                        instance={selectedInstance}
                        data={data}
                        mode={previewMode}
                        previewEnabled={previewEnabled}
                        onModeChange={setPreviewMode}
                        onPreviewEnabledChange={setPreviewEnabled}
                    />
                </section>
            )}
        </main>
    );
}
