import type { ReactNode } from 'react';
import { InstanceRow } from './InstanceRow';
import type {
    DashboardInstance,
    DashboardInstanceGroup,
    DashboardLifecycleAction,
    DashboardProfile,
} from '../types';
import { comparePinnedThenLabel } from './instance-row-status';
import { useSidebarGroupCollapse } from '../hooks/useSidebarGroupCollapse';

type InstanceGroupsProps = {
    instances: DashboardInstance[];
    profiles?: DashboardProfile[];
    selectedPort: number | null;
    lifecycleBusyPort: number | null;
    transitioningPort?: number | null;
    transitionAction?: DashboardLifecycleAction | null;
    activityUnreadByPort?: Record<number, number>;
    latestTitleByPort?: Record<number, string>;
    busyPorts?: Set<number>;
    showLatestActivityTitles?: boolean;
    showInlineLabelEditor?: boolean;
    showSidebarRuntimeLine?: boolean;
    showSelectedRowActions?: boolean;
    density?: 'compact' | 'comfortable' | 'rail';
    /** Session disclosure for the Active row (devlog 260806 D2). */
    activeSessionCount?: number;
    activeSessionsOpen?: boolean;
    onToggleActiveSessions?: (port: number) => void;
    renderActiveSessionList?: (port: number) => ReactNode;
    getLabel: (instance: DashboardInstance) => string;
    formatUptime: (seconds: number | null) => string;
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
    onMarkActivitySeen: (port: number) => void;
    onInstanceLabelSave: (port: number, label: string | null) => Promise<void>;
    onLifecycle: (action: DashboardLifecycleAction, instance: DashboardInstance) => void;
};

type InstanceGroupSectionProps = {
    group: DashboardInstanceGroup;
    props: InstanceGroupsProps;
    profileMap: Map<string, DashboardProfile>;
    collapsed: boolean;
    onToggle: () => void;
};

function withoutPorts(instances: DashboardInstance[], used: Set<number>): DashboardInstance[] {
    return instances.filter(instance => !used.has(instance.port));
}

function groupInstances(instances: DashboardInstance[], selectedPort: number | null): DashboardInstanceGroup[] {
    const used = new Set<number>();
    const selected = selectedPort == null ? [] : instances.filter(instance => instance.port === selectedPort);

    const favorites = withoutPorts(instances, used).filter(instance => instance.favorite);
    favorites.forEach(instance => used.add(instance.port));

    const userGroups = new Map<string, DashboardInstance[]>();
    for (const instance of withoutPorts(instances, used)) {
        if (!instance.group) continue;
        const group = userGroups.get(instance.group) || [];
        group.push(instance);
        userGroups.set(instance.group, group);
        used.add(instance.port);
    }

    const remaining = withoutPorts(instances, used);
    const running = remaining.filter(instance => instance.status === 'online');
    const attention = remaining.filter(instance => ['timeout', 'error', 'unknown'].includes(instance.status));
    const offline = remaining.filter(instance => instance.status === 'offline');
    const labelOf = (instance: Pick<DashboardInstance, 'label' | 'port'>) => instance.label || String(instance.port);
    favorites.sort((a, b) => comparePinnedThenLabel(a, b, labelOf));
    running.sort((a, b) => comparePinnedThenLabel(a, b, labelOf));
    attention.sort((a, b) => comparePinnedThenLabel(a, b, labelOf));
    offline.sort((a, b) => comparePinnedThenLabel(a, b, labelOf));
    for (const group of userGroups.values()) group.sort((a, b) => comparePinnedThenLabel(a, b, labelOf));

    const groups: DashboardInstanceGroup[] = [
        { id: 'active', label: 'Active', instances: selected },
        { id: 'favorites', label: 'Pinned', instances: favorites },
        ...Array.from(userGroups.entries()).map(([label, group]) => ({
            id: `group-${label}`,
            label,
            instances: group,
        })),
        { id: 'running', label: 'Running', instances: running },
        { id: 'attention', label: 'Attention', instances: attention },
        { id: 'offline', label: 'Offline', instances: offline },
    ];

    return groups.filter(group => group.instances.length > 0);
}

function renderInstanceRow(
    props: InstanceGroupsProps,
    instance: DashboardInstance,
    profile?: DashboardProfile,
    priority: 'active' | 'normal' = 'normal',
) {
    return (
        <InstanceRow
            key={instance.port}
            instance={instance}
            {...(profile !== undefined ? { profile } : {})}
            selected={props.selectedPort === instance.port}
            busy={props.lifecycleBusyPort === instance.port}
            transitioning={props.transitioningPort === instance.port ? props.transitionAction || null : null}
            activityUnreadCount={props.activityUnreadByPort?.[instance.port] || 0}
            latestActivityTitle={props.latestTitleByPort?.[instance.port] || null}
            agentBusy={props.busyPorts?.has(instance.port) || false}
            {...(props.showLatestActivityTitles !== undefined ? { showLatestActivityTitle: props.showLatestActivityTitles } : {})}
            {...(props.showInlineLabelEditor !== undefined ? { showInlineLabelEditor: props.showInlineLabelEditor } : {})}
            {...(props.showSidebarRuntimeLine !== undefined ? { showRuntimeLine: props.showSidebarRuntimeLine } : {})}
            {...(props.showSelectedRowActions !== undefined ? { showSelectedActions: props.showSelectedRowActions } : {})}
            {...(props.density !== undefined ? { density: props.density } : {})}
            {...(priority === 'active' && props.activeSessionCount !== undefined ? { sessionCount: props.activeSessionCount } : {})}
            {...(priority === 'active' && props.activeSessionsOpen !== undefined ? { sessionsOpen: props.activeSessionsOpen } : {})}
            {...(priority === 'active' && props.onToggleActiveSessions ? { onToggleSessions: props.onToggleActiveSessions } : {})}
            priority={priority}
            label={props.getLabel(instance)}
            uptime={props.formatUptime(instance.uptime)}
            onSelect={props.onSelect}
            onPreview={props.onPreview}
            onMarkActivitySeen={props.onMarkActivitySeen}
            onInstanceLabelSave={props.onInstanceLabelSave}
            onLifecycle={props.onLifecycle}
        />
    );
}

function InstanceGroupSection(section: InstanceGroupSectionProps) {
    const { group, props, profileMap, collapsed, onToggle } = section;
    const selected = group.instances.find(instance => instance.port === props.selectedPort);
    const visible = group.id === 'active' || !collapsed
        ? group.instances
        : selected ? [selected] : [];
    const header = group.id === 'active' ? (
        <div className="instance-group-header">
            <span>{group.label}</span>
            <strong>{group.instances.length}</strong>
        </div>
    ) : (
        <button
            type="button"
            className="instance-group-header instance-group-toggle"
            aria-expanded={!collapsed}
            aria-controls={`instance-group-body-${group.id}`}
            onClick={onToggle}
        >
            <span>
                <svg className="instance-group-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" /></svg>
                {' '}{group.label}
            </span>
            <strong>{group.instances.length}</strong>
        </button>
    );

    return (
        <section className="instance-group" key={group.id} aria-label={`${group.label} instances`}>
            {header}
            <div id={`instance-group-body-${group.id}`} hidden={collapsed && visible.length === 0}>
                {visible.map(instance => renderInstanceRow(
                    props,
                    instance,
                    instance.profileId ? profileMap.get(instance.profileId) : undefined,
                    group.id === 'active' ? 'active' : 'normal',
                ))}
                {group.id === 'active' && visible[0] ? props.renderActiveSessionList?.(visible[0].port) : null}
            </div>
        </section>
    );
}

export function InstanceGroups(props: InstanceGroupsProps) {
    const groups = groupInstances(props.instances, props.selectedPort);
    const profileMap = new Map((props.profiles || []).map(profile => [profile.profileId, profile]));
    const { isCollapsed, toggle: toggleGroup } = useSidebarGroupCollapse();

    if (groups.length === 0 && profileMap.size === 0) {
        return <section className="state">No matching instances found.</section>;
    }

    if (profileMap.size > 0) {
        return (
            <div className="instance-groups profile-instance-groups is-profile-merged">
                {groups.map(group => (
                    <InstanceGroupSection
                        key={group.id}
                        group={group}
                        props={props}
                        profileMap={profileMap}
                        collapsed={group.id === 'active' ? false : isCollapsed(group.id)}
                        onToggle={() => toggleGroup(group.id)}
                    />
                ))}
            </div>
        );
    }

    return (
        <div className="instance-groups">
            {groups.map(group => (
                <InstanceGroupSection
                    key={group.id}
                    group={group}
                    props={props}
                    profileMap={profileMap}
                    collapsed={group.id === 'active' ? false : isCollapsed(group.id)}
                    onToggle={() => toggleGroup(group.id)}
                />
            ))}
        </div>
    );
}
