import type { DashboardInstanceStatus } from '../types';

type StatusFilter = 'all' | DashboardInstanceStatus;

type CommandFiltersProps = {
    status: StatusFilter;
    customHome: string;
    showHidden: boolean;
    registryMessage: string | null;
    scanFrom: string;
    scanCount: string;
    onStatusChange: (value: StatusFilter) => void;
    onCustomHomeChange: (value: string) => void;
    onShowHiddenChange: (value: boolean) => void;
    onScanFromChange: (value: string) => void;
    onScanCountChange: (value: string) => void;
    onScanRangeCommit: (from: string, count: string) => void;
};

const STATUS_OPTIONS: StatusFilter[] = ['all', 'online', 'offline', 'timeout', 'error', 'unknown'];

export function CommandFilters(props: CommandFiltersProps) {
    const commitScanRange = (): void => props.onScanRangeCommit(props.scanFrom, props.scanCount);

    return (
        <>
            <select
                value={props.status}
                onChange={event => props.onStatusChange(event.target.value as StatusFilter)}
                aria-label="Filter by status"
            >
                {STATUS_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            <div className="launch-home-control">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                <input
                    className="home-input"
                    value={props.customHome}
                    onChange={event => props.onCustomHomeChange(event.target.value)}
                    placeholder="Launch home (e.g. ~/.cli-jaw-custom)"
                    aria-label="Custom home for started instances"
                />
            </div>
            <label className="toggle-control">
                <input
                    type="checkbox"
                    checked={props.showHidden}
                    onChange={event => props.onShowHiddenChange(event.target.checked)}
                />
                Hidden
            </label>
            <div className="scan-range-control">
                <input
                    value={props.scanFrom}
                    onChange={event => props.onScanFromChange(event.target.value)}
                    onBlur={commitScanRange}
                    onKeyDown={event => { if (event.key === 'Enter') commitScanRange(); }}
                    inputMode="numeric"
                    placeholder="from"
                    aria-label="Scan from port"
                />
                <input
                    value={props.scanCount}
                    onChange={event => props.onScanCountChange(event.target.value)}
                    onBlur={commitScanRange}
                    onKeyDown={event => { if (event.key === 'Enter') commitScanRange(); }}
                    inputMode="numeric"
                    placeholder="count"
                    aria-label="Scan port count"
                />
            </div>
            {props.registryMessage && <span className="registry-state-chip">{props.registryMessage}</span>}
        </>
    );
}
