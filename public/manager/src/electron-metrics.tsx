import { useEffect, useState } from 'react';

type MetricsProcessSample = {
    type: string;
    name?: string;
    pid: number;
    rssKb: number;
    cpu: number;
};

type MetricsSnapshot = {
    ts: number;
    rendererCount: number;
    mainCount: number;
    rssTotalKb: number;
    processes: MetricsProcessSample[];
};

type ElectronMetricsResponse =
    | { available: false; reason: string }
    | { available: true; snapshot: MetricsSnapshot | null };

const POLL_INTERVAL_MS = 5000;
// 1.5 GiB binary; tune if observed renderers settle higher under normal load.
export const WARN_THRESHOLD_KB = 1_572_864;
const NAME_CAP = 24;
const COLLAPSED_STORAGE_KEY = 'jaw.metricsPanelCollapsed';

async function fetchElectronMetrics(): Promise<ElectronMetricsResponse> {
    const response = await fetch('/api/dashboard/electron-metrics');
    if (!response.ok) throw new Error(`electron-metrics failed: ${response.status}`);
    return await response.json() as ElectronMetricsResponse;
}

function formatRss(kb: number): string {
    if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
    return `${(kb / 1024).toFixed(1)} MB`;
}

function capName(value: string): string {
    return value.length > NAME_CAP ? `${value.slice(0, NAME_CAP - 1)}…` : value;
}

function loadCollapsed(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
        return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function saveCollapsed(value: boolean): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? 'true' : 'false');
    } catch {
        // Storage may be disabled in private mode; ignore.
    }
}

export type ElectronMetricsPanelProps = {
    onUnloadPreview?: () => void;
};

export function ElectronMetricsPanel(props: ElectronMetricsPanelProps = {}) {
    const [available, setAvailable] = useState<boolean | null>(null);
    const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
    const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsed());

    useEffect(() => {
        saveCollapsed(collapsed);
    }, [collapsed]);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const tick = async () => {
            // D4: skip the work while the window is hidden, but keep the timer
            // chain alive so it resumes instantly on return. A poller that
            // exists to REPORT memory pressure should not be creating idle cost.
            if (typeof document !== 'undefined' && document.hidden) {
                if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
                return;
            }
            try {
                const result = await fetchElectronMetrics();
                if (cancelled) return;
                if (result.available) {
                    setAvailable(true);
                    setSnapshot(result.snapshot);
                } else {
                    setAvailable(false);
                    setSnapshot(null);
                }
            } catch {
                if (!cancelled) setAvailable(false);
            }
            if (!cancelled) {
                timer = setTimeout(tick, POLL_INTERVAL_MS);
            }
        };

        void tick();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, []);

    if (available !== true) return null;

    if (!snapshot) {
        return (
            <div className="electron-metrics-panel electron-metrics-panel--empty" aria-label="Electron process metrics">
                <div className="electron-metrics-header">
                    <span className="electron-metrics-title">Desktop metrics</span>
                </div>
                <div className="electron-metrics-empty">awaiting first sample…</div>
            </div>
        );
    }

    const topThree = [...snapshot.processes]
        .sort((a, b) => b.rssKb - a.rssKb)
        .slice(0, 3);
    const overThreshold = snapshot.rssTotalKb >= WARN_THRESHOLD_KB;
    const panelClass = `electron-metrics-panel${overThreshold ? ' electron-metrics-panel--warn' : ''}`;

    return (
        <div className={panelClass} aria-label="Electron process metrics">
            <div className="electron-metrics-header">
                <span className="electron-metrics-title">Desktop metrics</span>
                <button
                    type="button"
                    className="electron-metrics-toggle"
                    onClick={() => setCollapsed(value => !value)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? 'Expand metrics panel' : 'Collapse metrics panel'}
                >
                    {collapsed ? '▸' : '▾'}
                </button>
            </div>
            {!collapsed && (
                <div className="electron-metrics-body">
                    {overThreshold && (
                        <div className="electron-metrics-warn">
                            <span role="alert">Electron RSS total exceeds {formatRss(WARN_THRESHOLD_KB)}.</span>
                            {props.onUnloadPreview && (
                                <button
                                    type="button"
                                    className="electron-metrics-unload-btn"
                                    onClick={() => props.onUnloadPreview?.()}
                                >
                                    Unload preview
                                </button>
                            )}
                        </div>
                    )}
                    <div className="electron-metrics-row">
                        <span>renderers</span>
                        <span>{snapshot.rendererCount}</span>
                    </div>
                    <div className="electron-metrics-row">
                        <span>processes</span>
                        <span>{snapshot.processes.length}</span>
                    </div>
                    <div className="electron-metrics-row">
                        <span>RSS total</span>
                        <span>{formatRss(snapshot.rssTotalKb)}</span>
                    </div>
                    <div className="electron-metrics-divider" aria-hidden="true" />
                    <div className="electron-metrics-subtitle">top by RSS</div>
                    <ul className="electron-metrics-list">
                        {topThree.map((p) => (
                            <li key={p.pid}>
                                <span className="electron-metrics-proc">
                                    {capName(p.name ? `${p.type} · ${p.name}` : p.type)}
                                </span>
                                <span className="electron-metrics-proc-rss">{formatRss(p.rssKb)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
