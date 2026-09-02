import type { DashboardInstance, DashboardLifecycleAction } from '../types';

export type InstanceRowStatus =
    | 'working'
    | 'online'
    | 'offline'
    | 'attention'
    | 'transitioning';

export function resolveInstanceRowStatus(
    instance: Pick<DashboardInstance, 'status'>,
    flags: { busy?: boolean; transitioning?: DashboardLifecycleAction | null } = {},
): InstanceRowStatus {
    if (flags.transitioning) return 'transitioning';
    if (flags.busy) return 'working';
    if (instance.status === 'offline') return 'offline';
    if (instance.status === 'online') return 'online';
    return 'attention';
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
    const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function composeInstanceRowTitle(instance: Pick<DashboardInstance, 'port' | 'homeDisplay' | 'currentCli' | 'currentModel' | 'version'>): string {
    return [
        `:${instance.port}`,
        instance.homeDisplay || 'home n/a',
        instance.currentCli || 'cli n/a',
        instance.currentModel || 'model n/a',
        `v${instance.version || 'n/a'}`,
    ].join(' · ');
}

export function comparePinnedThenLabel<T extends Pick<DashboardInstance, 'favorite' | 'label' | 'port'>>(
    a: T,
    b: T,
    labelOf: (instance: T) => string,
): number {
    const fav = Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
    if (fav !== 0) return fav;
    const byLabel = labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' });
    return byLabel !== 0 ? byLabel : a.port - b.port;
}
