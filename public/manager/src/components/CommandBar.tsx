import type { DashboardInstanceStatus, DashboardScanResult } from '../types';

type StatusFilter = 'all' | DashboardInstanceStatus;

type CommandBarProps = {
    query: string;
    status: StatusFilter;
    customHome: string;
    loading: boolean;
    summary: Record<string, number>;
    manager: DashboardScanResult['manager'] | null;
    onQueryChange: (value: string) => void;
    onStatusChange: (value: StatusFilter) => void;
    onCustomHomeChange: (value: string) => void;
    onRefresh: () => void;
    onOpenDrawer: () => void;
};

const STATUS_OPTIONS: StatusFilter[] = ['all', 'online', 'offline', 'timeout', 'error', 'unknown'];

export function CommandBar(props: CommandBarProps) {
    const range = props.manager ? `${props.manager.rangeFrom}-${props.manager.rangeTo}` : '3457-3506';
    const managerPort = props.manager?.port || 24576;

    return (
        <div className="command-bar">
            <button className="drawer-trigger" type="button" onClick={props.onOpenDrawer}>
                Instances
            </button>
            <div className="command-title">
                <p className="eyebrow">Jaw Manager</p>
                <h1>Instance dashboard</h1>
            </div>
            <div className="command-search">
                <input
                    value={props.query}
                    onChange={event => props.onQueryChange(event.target.value)}
                    placeholder="Search port, home, CLI, model"
                    aria-label="Search instances"
                />
                <select
                    value={props.status}
                    onChange={event => props.onStatusChange(event.target.value as StatusFilter)}
                    aria-label="Filter by status"
                >
                    {STATUS_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
                <input
                    className="home-input"
                    value={props.customHome}
                    onChange={event => props.onCustomHomeChange(event.target.value)}
                    placeholder="Custom home, default ~/.cli-jaw-<port>"
                    aria-label="Custom home for started instances"
                />
            </div>
            <div className="command-meta">
                <span>Total {props.summary.total || 0}</span>
                <span>Online {props.summary.online || 0}</span>
                <span>Offline {props.summary.offline || 0}</span>
                <span>Timeout {props.summary.timeout || 0}</span>
                <span>Manager {managerPort}</span>
                <span>Scan {range}</span>
                <button type="button" onClick={props.onRefresh} disabled={props.loading}>
                    {props.loading ? 'Scanning' : 'Refresh'}
                </button>
            </div>
        </div>
    );
}
