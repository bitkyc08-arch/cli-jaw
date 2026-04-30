import type { DashboardSidebarMode } from '../types';

type SidebarRailProps = {
    onlineCount: number;
    collapsed: boolean;
    mode: DashboardSidebarMode;
    onModeChange: (mode: DashboardSidebarMode) => void;
    onToggleSidebar: () => void;
};

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

function MonitorIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="14" height="10" rx="1.5" />
            <path d="M8 17h4M10 14v3" />
        </svg>
    );
}

function NoteIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M6 3h6l3 3v11H6z" />
            <path d="M12 3v4h3M8 10h5M8 13h5" />
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
            <button
                className={`rail-button rail-workspace-button${props.mode === 'instances' ? ' is-active' : ''}`}
                type="button"
                onClick={() => props.onModeChange('instances')}
                aria-label="Instances"
                aria-pressed={props.mode === 'instances'}
                title="Instances"
            >
                <MonitorIcon />
            </button>
            <button
                className={`rail-button rail-workspace-button${props.mode === 'notes' ? ' is-active' : ''}`}
                type="button"
                onClick={() => props.onModeChange('notes')}
                aria-label="Notes"
                aria-pressed={props.mode === 'notes'}
                title="Notes"
            >
                <NoteIcon />
            </button>
            <div className="rail-spacer" />
            <span className="rail-status-dot" aria-label={`${props.onlineCount} online instances`} />
        </div>
    );
}
