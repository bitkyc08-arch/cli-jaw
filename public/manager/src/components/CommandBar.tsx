import type { DashboardInstanceStatus, DashboardScanResult } from '../types';
import { CommandCenter } from './CommandCenter';
import { CommandFilters } from './CommandFilters';

type StatusFilter = 'all' | DashboardInstanceStatus;

type CommandBarProps = {
    query: string;
    status: StatusFilter;
    customHome: string;
    loading: boolean;
    summary: Record<string, number>;
    manager: DashboardScanResult['manager'] | null;
    showHidden: boolean;
    registryMessage: string | null;
    scanFrom: string;
    scanCount: string;
    onQueryChange: (value: string) => void;
    onStatusChange: (value: StatusFilter) => void;
    onCustomHomeChange: (value: string) => void;
    onShowHiddenChange: (value: boolean) => void;
    onScanFromChange: (value: string) => void;
    onScanCountChange: (value: string) => void;
    onScanRangeCommit: (from: string, count: string) => void;
    onRefresh: () => void;
    onOpenDrawer: () => void;
};

export function CommandBar(props: CommandBarProps) {
    const range = props.manager ? `${props.manager.rangeFrom}-${props.manager.rangeTo}` : '3457-3506';
    const managerPort = props.manager?.port || 24576;

    return (
        <CommandCenter
            mobileMenuButton={(
                <button className="drawer-trigger" type="button" onClick={props.onOpenDrawer}>
                    Instances
                </button>
            )}
            title={(
                <>
                    <p className="eyebrow">Jaw Manager</p>
                    <h1>Instance dashboard</h1>
                </>
            )}
            search={(
                <input
                    value={props.query}
                    onChange={event => props.onQueryChange(event.target.value)}
                    placeholder="Search port, home, CLI, model"
                    aria-label="Search instances"
                />
            )}
            actions={(
                <button type="button" onClick={props.onRefresh} disabled={props.loading}>
                    {props.loading ? 'Scanning' : 'Refresh'}
                </button>
            )}
            filters={(
                <CommandFilters
                    status={props.status}
                    customHome={props.customHome}
                    showHidden={props.showHidden}
                    registryMessage={props.registryMessage}
                    scanFrom={props.scanFrom}
                    scanCount={props.scanCount}
                    onStatusChange={props.onStatusChange}
                    onCustomHomeChange={props.onCustomHomeChange}
                    onShowHiddenChange={props.onShowHiddenChange}
                    onScanFromChange={props.onScanFromChange}
                    onScanCountChange={props.onScanCountChange}
                    onScanRangeCommit={props.onScanRangeCommit}
                />
            )}
            summary={(
                <>
                    <span>Total {props.summary.total || 0}</span>
                    <span>Online {props.summary.online || 0}</span>
                    <span>Offline {props.summary.offline || 0}</span>
                    <span>Timeout {props.summary.timeout || 0}</span>
                    <span>Manager {managerPort}</span>
                    <span>Scan {range}</span>
                </>
            )}
        />
    );
}
