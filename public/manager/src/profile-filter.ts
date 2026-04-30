import type { DashboardProfile } from './types';

export function reconcileActiveProfileFilter(activeIds: string[], profiles: DashboardProfile[]): string[] {
    if (activeIds.length === 0) return activeIds;
    const known = new Set(profiles.map(profile => profile.profileId));
    const next = activeIds.filter(profileId => known.has(profileId));
    return next.length === activeIds.length ? activeIds : next;
}
