// Phase 9 — sidebar with search + group collapse.
//
// Each group has a `<details>` element so collapse is keyboard-accessible
// out of the box. Search filters across labels/ids; empty groups are hidden.

import { useCallback, useState } from 'react';
import type { SettingsCategoryId, SettingsCategoryGroup } from './types';
import { SidebarSearch } from './components/SidebarSearch';
import {
    filterEntries,
    groupEntries,
    type SidebarEntry,
} from './components/sidebar-filter';

const CATEGORIES: SidebarEntry[] = [
    { id: 'profile', label: 'Profile', group: 'core' },
    { id: 'display', label: 'Display', group: 'core' },
    { id: 'model', label: 'Model & provider', group: 'core' },
    { id: 'channels-telegram', label: 'Channels — Telegram', group: 'channels' },
    { id: 'channels-discord', label: 'Channels — Discord', group: 'channels' },
    { id: 'speech', label: 'Speech & keys', group: 'integrations' },
    { id: 'heartbeat', label: 'Heartbeat & schedules', group: 'automation' },
    { id: 'memory', label: 'Memory', group: 'automation' },
    { id: 'employees', label: 'Employees', group: 'automation' },
    { id: 'prompts', label: 'Prompts', group: 'integrations' },
    { id: 'mcp', label: 'MCP servers', group: 'integrations' },
    { id: 'browser', label: 'Browser / CDP', group: 'integrations' },
    { id: 'network', label: 'Network', group: 'security' },
    { id: 'permissions', label: 'Permissions', group: 'security' },
    { id: 'dashboard-meta', label: 'Dashboard meta', group: 'meta' },
    { id: 'advanced-export', label: 'Export / import', group: 'meta' },
];

type Props = {
    activeId: SettingsCategoryId;
    onSelect: (id: SettingsCategoryId) => void;
};

export function SettingsSidebar({ activeId, onSelect }: Props) {
    const [filter, setFilter] = useState('');
    const [collapsed, setCollapsed] = useState<Set<SettingsCategoryGroup>>(new Set());

    const visible = filterEntries(CATEGORIES, filter);
    const groups = groupEntries(visible);

    const toggleGroup = useCallback((group: SettingsCategoryGroup) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(group)) next.delete(group);
            else next.add(group);
            return next;
        });
    }, []);

    return (
        <nav className="settings-sidebar" aria-label="Settings categories">
            <SidebarSearch value={filter} onChange={setFilter} />
            {groups.length === 0 ? (
                <p className="settings-sidebar-empty">No matches.</p>
            ) : null}
            {groups.map(({ group, label, items }) => {
                const isCollapsed = collapsed.has(group);
                return (
                    <section key={group} className="settings-sidebar-group">
                        <button
                            type="button"
                            className="settings-sidebar-group-header"
                            aria-expanded={!isCollapsed}
                            aria-controls={`settings-sidebar-group-${group}`}
                            onClick={() => toggleGroup(group)}
                        >
                            <span className="settings-sidebar-group-caret" aria-hidden="true">
                                {isCollapsed ? '▸' : '▾'}
                            </span>
                            <span className="settings-sidebar-group-label">{label}</span>
                        </button>
                        {!isCollapsed ? (
                            <div
                                id={`settings-sidebar-group-${group}`}
                                role="tablist"
                                className="settings-sidebar-group-items"
                            >
                                {items.map((c) => {
                                    const isActive = c.id === activeId;
                                    return (
                                        <button
                                            key={c.id}
                                            type="button"
                                            role="tab"
                                            aria-selected={isActive}
                                            aria-current={isActive ? 'page' : undefined}
                                            className={`settings-sidebar-item${isActive ? ' is-active' : ''}`}
                                            onClick={() => onSelect(c.id)}
                                        >
                                            {c.label}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </section>
                );
            })}
        </nav>
    );
}

export const SETTINGS_CATEGORIES: ReadonlyArray<SidebarEntry> = CATEGORIES;
