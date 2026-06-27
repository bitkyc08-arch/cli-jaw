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
    { id: 'agent', label: 'Agent', group: 'runtime' },
    { id: 'model', label: 'Model defaults', group: 'runtime' },
    { id: 'profile', label: 'Profile', group: 'identity' },
    { id: 'display', label: 'Display', group: 'identity' },
    { id: 'channels-telegram', label: 'Channels — Telegram', group: 'channels' },
    { id: 'channels-discord', label: 'Channels — Discord', group: 'channels' },
    { id: 'telegram-hub', label: 'Telegram Hub', group: 'channels' },
    { id: 'heartbeat', label: 'Heartbeat & schedules', group: 'automation' },
    { id: 'memory', label: 'Memory', group: 'automation' },
    { id: 'mcp', label: 'MCP servers', group: 'mcp' },
    { id: 'speech', label: 'Speech & keys', group: 'integrations' },
    { id: 'prompts', label: 'Prompts', group: 'integrations' },
    { id: 'browser', label: 'Browser / CDP', group: 'integrations' },
    { id: 'network', label: 'Network', group: 'network-security' },
    { id: 'permissions', label: 'Permissions', group: 'network-security' },
    { id: 'dashboard-meta', label: 'Dashboard meta', group: 'advanced' },
    { id: 'advanced-export', label: 'Export / import', group: 'advanced' },
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
