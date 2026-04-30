import { EmptyNavigator } from './EmptyNavigator';
import { InstanceGroups } from './InstanceGroups';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardProfile,
    DashboardScanResult,
} from '../types';

type InstanceListContentProps = {
    error: string | null;
    loading: boolean;
    instances: DashboardInstance[];
    filtered: DashboardInstance[];
    selectedInstance: DashboardInstance | null;
    data: DashboardScanResult | null;
    lifecycleBusyPort: number | null;
    transitioningPort: number | null;
    transitionAction: DashboardLifecycleAction | null;
    activityUnreadByPort: Record<string, number>;
    latestTitleByPort: Record<number, string>;
    profiles: DashboardProfile[];
    getLabel: (instance: DashboardInstance) => string;
    formatUptime: (seconds: number | null) => string;
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
    onMarkActivitySeen: (port: number) => void;
    onInstanceLabelSave: (port: number, label: string | null) => Promise<void>;
    onLifecycle: (action: DashboardLifecycleAction, instance: DashboardInstance) => void;
};

export function InstanceListContent(props: InstanceListContentProps) {
    const showEmpty = !props.error && !props.loading && props.instances.length === 0
        && !props.instances.some(instance => instance.hidden);
    const visibleInstances = props.selectedInstance && !props.filtered.some(instance => instance.port === props.selectedInstance?.port)
        ? [props.selectedInstance, ...props.filtered]
        : props.filtered;

    return (
        <>
            {props.error && <section className="state error-state">Scan failed: {props.error}</section>}
            {!props.error && props.loading && <section className="state">Scanning local Jaw instances...</section>}
            {showEmpty && props.data?.manager && (
                <EmptyNavigator
                    rangeFrom={props.data.manager.rangeFrom}
                    rangeTo={props.data.manager.rangeTo}
                />
            )}
            {!props.error && !showEmpty && (
                <InstanceGroups
                    instances={visibleInstances}
                    selectedPort={props.selectedInstance?.port || null}
                    lifecycleBusyPort={props.lifecycleBusyPort}
                    transitioningPort={props.transitioningPort}
                    transitionAction={props.transitionAction}
                    activityUnreadByPort={props.activityUnreadByPort}
                    latestTitleByPort={props.latestTitleByPort}
                    profiles={props.profiles}
                    getLabel={props.getLabel}
                    formatUptime={props.formatUptime}
                    onSelect={props.onSelect}
                    onPreview={props.onPreview}
                    onMarkActivitySeen={props.onMarkActivitySeen}
                    onInstanceLabelSave={props.onInstanceLabelSave}
                    onLifecycle={props.onLifecycle}
                />
            )}
        </>
    );
}
