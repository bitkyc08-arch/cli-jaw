import type { DashboardDetailTab } from '../types';

type SidebarRailProps = {
    onlineCount: number;
    collapsed: boolean;
    activeTab: DashboardDetailTab;
    activityOpen: boolean;
    onSelectInstances: () => void;
    onSelectPreview: () => void;
    onSelectActivity: () => void;
    onToggleSidebar: () => void;
};

type RailItemProps = {
    label: string;
    shortLabel: string;
    active?: boolean;
    onClick?: () => void;
};

function RailItem(props: RailItemProps) {
    return (
        <button
            className={props.active ? 'rail-button is-active' : 'rail-button'}
            type="button"
            onClick={props.onClick}
            aria-label={props.label}
            title={props.label}
        >
            <span className="rail-button-short" aria-hidden="true">{props.shortLabel}</span>
            <span className="rail-button-label">{props.label}</span>
        </button>
    );
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
    const points = direction === 'left' ? '11 4 5 10 11 16' : '5 4 11 10 5 16';
    return (
        <svg
            className="rail-collapse-chevron"
            viewBox="0 0 16 20"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <polyline points={points} />
        </svg>
    );
}

export function SidebarRail(props: SidebarRailProps) {
    const expanded = !props.collapsed;
    const toggleLabel = expanded ? 'Collapse navigation' : 'Expand navigation';
    return (
        <div className="sidebar-rail">
            <button
                className="rail-collapse-button"
                type="button"
                onClick={props.onToggleSidebar}
                aria-label={toggleLabel}
                aria-expanded={expanded}
                aria-pressed={props.collapsed}
                aria-controls="manager-sidebar-list"
                title={toggleLabel}
            >
                <ChevronIcon direction={expanded ? 'left' : 'right'} />
            </button>
            <RailItem label="Instances" shortLabel="I" active={props.activeTab === 'overview'} onClick={props.onSelectInstances} />
            <RailItem label="Preview" shortLabel="P" active={props.activeTab === 'preview'} onClick={props.onSelectPreview} />
            <RailItem
                label="Activity"
                shortLabel="A"
                active={props.activityOpen}
                onClick={props.onSelectActivity}
            />
            <RailItem label="Settings" shortLabel="S" active={props.activeTab === 'settings'} />
            <div className="rail-spacer" />
            <span className="rail-status-dot" aria-label={`${props.onlineCount} online instances`} />
        </div>
    );
}
