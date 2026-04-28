import type { SettingsCategoryId, SettingsCategoryGroup } from './types';

type SidebarEntry = {
    id: SettingsCategoryId;
    label: string;
    group: SettingsCategoryGroup;
};

const CATEGORIES: SidebarEntry[] = [
    { id: 'profile', label: 'Profile', group: 'core' },
    { id: 'display', label: 'Display', group: 'core' },
    { id: 'model', label: 'Model & provider', group: 'core' },
    { id: 'identity-preview', label: 'Identity (preview)', group: 'core' },
    { id: 'channels-telegram', label: 'Channels — Telegram', group: 'channels' },
    { id: 'channels-discord', label: 'Channels — Discord', group: 'channels' },
    { id: 'speech', label: 'Speech & keys', group: 'integrations' },
    // Phases 5–9 will register their entries here.
];

type Props = {
    activeId: SettingsCategoryId;
    onSelect: (id: SettingsCategoryId) => void;
};

export function SettingsSidebar({ activeId, onSelect }: Props) {
    return (
        <nav className="settings-sidebar" aria-label="Settings categories" role="tablist">
            {CATEGORIES.map((c) => {
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
        </nav>
    );
}

export const SETTINGS_CATEGORIES: ReadonlyArray<SidebarEntry> = CATEGORIES;
