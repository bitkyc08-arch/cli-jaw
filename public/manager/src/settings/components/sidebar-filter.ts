// Phase 9 — sidebar filter helpers (extracted for unit testing).
//
// Pure functions so we can verify search-filter and group-collapse logic
// without mounting React.

import type { SettingsCategoryGroup, SettingsCategoryId } from '../types';

export type SidebarEntry = {
    id: SettingsCategoryId;
    label: string;
    group: SettingsCategoryGroup;
};

export const SIDEBAR_GROUP_ORDER: ReadonlyArray<SettingsCategoryGroup> = [
    'core',
    'channels',
    'automation',
    'integrations',
    'security',
    'meta',
];

export const SIDEBAR_GROUP_LABELS: Record<SettingsCategoryGroup, string> = {
    core: 'Core',
    channels: 'Channels',
    automation: 'Automation',
    integrations: 'Integrations',
    security: 'Security',
    meta: 'Meta',
};

export function filterEntries(
    entries: ReadonlyArray<SidebarEntry>,
    rawQuery: string,
): SidebarEntry[] {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return entries.slice();
    return entries.filter((entry) =>
        entry.label.toLowerCase().includes(query) ||
        entry.id.toLowerCase().includes(query),
    );
}

export function groupEntries(
    entries: ReadonlyArray<SidebarEntry>,
): Array<{ group: SettingsCategoryGroup; label: string; items: SidebarEntry[] }> {
    const buckets = new Map<SettingsCategoryGroup, SidebarEntry[]>();
    for (const entry of entries) {
        const list = buckets.get(entry.group) || [];
        list.push(entry);
        buckets.set(entry.group, list);
    }
    return SIDEBAR_GROUP_ORDER
        .filter((group) => (buckets.get(group)?.length ?? 0) > 0)
        .map((group) => ({
            group,
            label: SIDEBAR_GROUP_LABELS[group],
            items: buckets.get(group) ?? [],
        }));
}
