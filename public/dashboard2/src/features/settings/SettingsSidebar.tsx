import { Search } from '@lucide/icons';
import { useMemo, useState, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import type { SettingsCategory, SettingsPageId } from './settings-types.ts';

interface Props {
    categories: SettingsCategory[];
    activeId: SettingsPageId;
    onSelect(id: SettingsPageId): void;
}

export function SettingsSidebar({ categories, activeId, onSelect }: Props): JSX.Element {
    const [query, setQuery] = useState('');
    const visible = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        return needle
            ? categories.filter((item) => `${item.label} ${item.description}`.toLocaleLowerCase().includes(needle))
            : categories;
    }, [categories, query]);

    return (
        <nav className="d2-settings-sidebar" aria-label="Settings categories">
            <label className="d2-settings-search">
                <Icon icon={Search} size={14} />
                <span className="d2-settings-sr-only">Search settings</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" />
            </label>
            <div className="d2-settings-nav-list">
                {visible.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={`d2-settings-nav-item${activeId === item.id ? ' active' : ''}`}
                        aria-current={activeId === item.id ? 'page' : undefined}
                        onClick={() => onSelect(item.id)}
                    >
                        <span>{item.label}</span>
                        <small>{item.description}</small>
                    </button>
                ))}
                {visible.length === 0 ? <p className="d2-settings-empty">No matching settings.</p> : null}
            </div>
        </nav>
    );
}
