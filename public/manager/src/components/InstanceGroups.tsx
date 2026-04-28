import { InstanceRow } from './InstanceRow';
import type {
    DashboardInstance,
    DashboardInstanceGroup,
    DashboardLifecycleAction,
    DashboardProfile,
} from '../types';

type InstanceGroupsProps = {
    instances: DashboardInstance[];
    profiles?: DashboardProfile[];
    selectedPort: number | null;
    lifecycleBusyPort: number | null;
    transitioningPort?: number | null;
    transitionAction?: DashboardLifecycleAction | null;
    getLabel: (instance: DashboardInstance) => string;
    formatUptime: (seconds: number | null) => string;
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
    onLifecycle: (action: DashboardLifecycleAction, instance: DashboardInstance) => void;
};

function withoutPorts(instances: DashboardInstance[], used: Set<number>): DashboardInstance[] {
    return instances.filter(instance => !used.has(instance.port));
}

function profileRank(profile: DashboardProfile): number {
    return profile.label === 'default' || profile.profileId === 'default' ? 0 : 1;
}

function sortProfiles(profiles: DashboardProfile[]): DashboardProfile[] {
    return [...profiles].sort((left, right) => {
        const rankDelta = profileRank(left) - profileRank(right);
        if (rankDelta !== 0) return rankDelta;
        return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function groupInstances(instances: DashboardInstance[], selectedPort: number | null): DashboardInstanceGroup[] {
    const used = new Set<number>();
    const selected = selectedPort == null ? [] : instances.filter(instance => instance.port === selectedPort);
    selected.forEach(instance => used.add(instance.port));

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
) {
    return (
        <InstanceRow
            key={instance.port}
            instance={instance}
            profile={profile}
            selected={props.selectedPort === instance.port}
            busy={props.lifecycleBusyPort === instance.port}
            transitioning={props.transitioningPort === instance.port ? props.transitionAction || null : null}
            label={props.getLabel(instance)}
            uptime={props.formatUptime(instance.uptime)}
            onSelect={props.onSelect}
            onPreview={props.onPreview}
            onLifecycle={props.onLifecycle}
        />
    );
}

function renderRows(props: InstanceGroupsProps, instances: DashboardInstance[]) {
    return groupInstances(instances, props.selectedPort).map(group => (
        <section className="instance-group" key={group.id} aria-label={`${group.label} instances`}>
            <div className="instance-group-header">
                <span>{group.label}</span>
                <strong>{group.instances.length}</strong>
            </div>
            {group.instances.map(instance => renderInstanceRow(props, instance))}
        </section>
    ));
}

export function InstanceGroups(props: InstanceGroupsProps) {
    const groups = groupInstances(props.instances, props.selectedPort);
    const profileMap = new Map((props.profiles || []).map(profile => [profile.profileId, profile]));

    if (groups.length === 0 && profileMap.size === 0) {
        return <section className="state">No matching instances found.</section>;
    }

    if (profileMap.size > 0) {
        const used = new Set<number>();
        return (
            <div className="instance-groups profile-instance-groups is-profile-merged">
                {sortProfiles(Array.from(profileMap.values())).map((profile) => {
                    const profileInstances = props.instances.filter(instance => instance.profileId === profile.profileId);
                    profileInstances.forEach(instance => used.add(instance.port));
                    if (profileInstances.length > 0) {
                        return profileInstances.map(instance => renderInstanceRow(props, instance, profile));
                    }

                    return (
                        <section className="state profile-empty" key={profile.profileId}>
                            <strong>{profile.label}</strong>
                            <span>No online instances for this profile.</span>
                        </section>
                    );
                })}
                {renderRows(props, props.instances.filter(instance => !used.has(instance.port)))}
            </div>
        );
    }

    return (
        <div className="instance-groups">
            {renderRows(props, props.instances)}
        </div>
    );
}
