import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
    DashboardInstance,
    DashboardProfile,
    DashboardProfileId,
    DashboardServiceMode,
} from './types.js';

function normalizeHomePath(homePath: string): string {
    return resolve(homePath.replace(/^~(?=\/|$)/, homedir()));
}

function slugPart(value: string): string {
    const slug = value
        .replace(/^\./, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'home';
}

export function deriveProfileId(homePath: string): DashboardProfileId {
    const normalized = normalizeHomePath(homePath);
    const base = basename(normalized);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(normalized).digest('hex').slice(0, 8);
    return `${slugPart(base)}-${hash}`;
}

export function deriveProfile(instance: DashboardInstance): DashboardProfile | null {
    const homePath = instance.homeDisplay || instance.workingDir;
    if (!homePath) return null;
    const normalized = normalizeHomePath(homePath);
    const profileId = deriveProfileId(normalized);
    const base = basename(normalized);
    return {
        profileId,
        label: profileId === 'default' ? 'default' : (slugPart(base) || profileId),
        homePath: normalized,
        preferredPort: instance.port,
        serviceMode: instance.serviceMode,
        defaultCli: instance.currentCli,
        notes: null,
        lastSeenAt: instance.ok ? instance.lastCheckedAt : null,
        pinned: false,
        color: null,
    };
}

function serviceModeRank(mode: DashboardServiceMode): number {
    return mode === 'manager' ? 4 : mode === 'service' ? 3 : mode === 'ad-hoc' ? 2 : 1;
}

function mergeProfile(base: DashboardProfile, incoming: DashboardProfile): DashboardProfile {
    return {
        ...base,
        preferredPort: incoming.preferredPort ?? base.preferredPort,
        serviceMode: serviceModeRank(incoming.serviceMode) > serviceModeRank(base.serviceMode) ? incoming.serviceMode : base.serviceMode,
        defaultCli: incoming.defaultCli ?? base.defaultCli,
        lastSeenAt: incoming.lastSeenAt ?? base.lastSeenAt,
    };
}

export function deriveProfiles(instances: DashboardInstance[]): { instances: DashboardInstance[]; profiles: DashboardProfile[] } {
    const profiles = new Map<DashboardProfileId, DashboardProfile>();
    const withProfiles = instances.map((instance) => {
        const profile = deriveProfile(instance);
        if (!profile) return { ...instance, profileId: null };
        profiles.set(profile.profileId, profiles.has(profile.profileId)
            ? mergeProfile(profiles.get(profile.profileId) as DashboardProfile, profile)
            : profile);
        return { ...instance, profileId: profile.profileId };
    });
    return { instances: withProfiles, profiles: sortProfiles(Array.from(profiles.values())) };
}

export function mergeProfiles(existing: DashboardProfile[], incoming: DashboardProfile[]): DashboardProfile[] {
    const byId = new Map<DashboardProfileId, DashboardProfile>();
    for (const profile of existing) byId.set(profile.profileId, profile);
    for (const profile of incoming) byId.set(profile.profileId, byId.has(profile.profileId)
        ? mergeProfile(byId.get(profile.profileId) as DashboardProfile, profile)
        : profile);
    return sortProfiles(Array.from(byId.values()));
}

export function sortProfiles(profiles: DashboardProfile[]): DashboardProfile[] {
    return [...profiles].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const timeA = a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0;
        const timeB = b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0;
        if (timeA !== timeB) return timeB - timeA;
        return a.label.localeCompare(b.label);
    });
}

export function filterByProfile(instances: DashboardInstance[], profileIds: DashboardProfileId[]): DashboardInstance[] {
    if (profileIds.length === 0) return instances;
    const active = new Set(profileIds);
    return instances.filter(instance => instance.profileId && active.has(instance.profileId));
}
