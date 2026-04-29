import { ProfileChip } from './ProfileChip';
import type { DashboardInstanceStatus, DashboardProfile } from '../types';

type StatusFilter = 'all' | DashboardInstanceStatus;

type CommandFiltersProps = {
    status: StatusFilter;
    customHome: string;
    showHidden: boolean;
    profiles: DashboardProfile[];
    activeProfileIds: string[];
    profileCounts: Record<string, number>;
    registryMessage: string | null;
    scanFrom: string;
    scanCount: string;
    onStatusChange: (value: StatusFilter) => void;
    onCustomHomeChange: (value: string) => void;
    onShowHiddenChange: (value: boolean) => void;
    onProfileToggle: (profileId: string) => void;
    onScanFromChange: (value: string) => void;
    onScanCountChange: (value: string) => void;
    onScanRangeCommit: (from: string, count: string) => void;
    rangeLabel: string;
    managerPort: number;
    countLabel: string;
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
                title="Filter by status"
            >
                {STATUS_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            <span className="command-mini-stat" title="Online / total instances">
                {props.countLabel}
            </span>
            {props.profiles.length > 0 && (
                <div className="profile-chip-strip" aria-label="Profile filters">
                    {props.profiles.map(profile => (
                        <ProfileChip
                            key={profile.profileId}
                            profile={profile}
                            active={props.activeProfileIds.includes(profile.profileId)}
                            count={props.profileCounts[profile.profileId] || 0}
                            onToggle={props.onProfileToggle}
                        />
                    ))}
                </div>
            )}
            <div className="launch-home-control">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                <input
                    className="home-input"
                    value={props.customHome}
                    onChange={event => props.onCustomHomeChange(event.target.value)}
                    placeholder="Launch home (e.g. ~/.cli-jaw-custom)"
                    aria-label="Custom home for started instances"
                    title="Custom home, default ~/.cli-jaw-<port>"
                />
            </div>
            <label className="toggle-control compact-toggle" title="Show hidden instances">
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
            <span className="command-mini-stat" title={`Manager ${props.managerPort}, scan ${props.rangeLabel}`}>
                :{props.managerPort} / {props.rangeLabel}
            </span>
            {props.registryMessage && <span className="registry-state-chip">{props.registryMessage}</span>}
        </>
    );
}
