import type { DashboardInstanceStatus, DashboardProfile, DashboardScanResult, DashboardUiTheme } from '../types';
import { CommandCenter } from './CommandCenter';
import { CommandFilters } from './CommandFilters';
import { ThemeSwitch } from './ThemeSwitch';

type StatusFilter = 'all' | DashboardInstanceStatus;

type CommandBarProps = {
    query: string;
    status: StatusFilter;
    customHome: string;
    loading: boolean;
    summary: Record<string, number>;
    manager: DashboardScanResult['manager'] | null;
    showHidden: boolean;
    profiles: DashboardProfile[];
    activeProfileIds: string[];
    profileCounts: Record<string, number>;
    registryMessage: string | null;
    scanFrom: string;
    scanCount: string;
    theme: DashboardUiTheme;
    onQueryChange: (value: string) => void;
    onStatusChange: (value: StatusFilter) => void;
    onCustomHomeChange: (value: string) => void;
    onShowHiddenChange: (value: boolean) => void;
    onProfileToggle: (profileId: string) => void;
    onScanFromChange: (value: string) => void;
    onScanCountChange: (value: string) => void;
    onScanRangeCommit: (from: string, count: string) => void;
    onRefresh: () => void;
    onOpenDrawer: () => void;
    onThemeChange: (next: DashboardUiTheme) => void;
    onOpenPalette: () => void;
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
                <div className="search-input-wrapper">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input
                        value={props.query}
                        onChange={event => props.onQueryChange(event.target.value)}
                        placeholder="Search port, home, CLI, model"
                        aria-label="Search instances"
                    />
                </div>
            )}
            actions={(
                <div className="command-actions-group">
                    <button
                        type="button"
                        className="command-palette-trigger"
                        onClick={props.onOpenPalette}
                        aria-label="Open command palette"
                        title="Open command palette (⌘K / Ctrl+K)"
                    >
                        <span aria-hidden="true">⌘K</span>
                    </button>
                    <ThemeSwitch theme={props.theme} onChange={props.onThemeChange} />
                    <button type="button" onClick={props.onRefresh} disabled={props.loading}>
                        {props.loading ? 'Scanning' : 'Refresh'}
                    </button>
                </div>
            )}
            filters={(
                <CommandFilters
                    status={props.status}
                    customHome={props.customHome}
                    showHidden={props.showHidden}
                    profiles={props.profiles}
                    activeProfileIds={props.activeProfileIds}
                    profileCounts={props.profileCounts}
                    registryMessage={props.registryMessage}
                    scanFrom={props.scanFrom}
                    scanCount={props.scanCount}
                    onStatusChange={props.onStatusChange}
                    onCustomHomeChange={props.onCustomHomeChange}
                    onShowHiddenChange={props.onShowHiddenChange}
                    onProfileToggle={props.onProfileToggle}
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
