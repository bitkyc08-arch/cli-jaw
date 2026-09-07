import { useId, useState } from 'react';
import type { SettingsCategoryId, SettingsScope } from './types';
import type { DashboardLocale } from '../types';
import { SETTINGS_REGISTRY, entriesForScopes } from './settings-registry';
import { SidebarSearch } from './components/SidebarSearch';
import { filterEntries, groupEntries } from './components/sidebar-filter';
type Props = { activeId: SettingsCategoryId; scopes: readonly SettingsScope[]; hasInstance: boolean; locale: DashboardLocale;
    onSelect: (id: SettingsCategoryId) => void };
export function SettingsSidebar({activeId, scopes, hasInstance, locale, onSelect}: Props) {
    const [filter, setFilter] = useState(''); const prefix = useId();
    const entries = entriesForScopes(scopes, hasInstance, locale);
    return <nav className="settings-sidebar" aria-label="Settings categories">
        <SidebarSearch value={filter} onChange={setFilter}/>
        {!filterEntries(entries, filter).length && <p role="status">No matches.</p>}
        {(['instance','manager'] as const).map(scope => {
            const groups = groupEntries(filterEntries(entries.filter(e=>e.scope===scope), filter));
            if (!groups.length) return null;
            return <section key={scope} aria-labelledby={`${prefix}-${scope}`}>
                <h2 id={`${prefix}-${scope}`}>{scope==='instance'?'Instance':'Manager'}</h2>
                {groups.map(({group,label,items})=><details key={`${group}:${Boolean(filter)}`} open className="settings-sidebar-group">
                    <summary className="settings-sidebar-group-header">{label}</summary>
                    <div className="settings-sidebar-group-items">{items.map(entry=><button type="button" key={entry.id}
                        aria-current={entry.id===activeId?'page':undefined}
                        className={`settings-sidebar-item${entry.id===activeId?' is-active':''}`}
                        onClick={()=>onSelect(entry.id)}>{entry.label}</button>)}</div>
                </details>)}
            </section>;
        })}
    </nav>;
}
/** Visible categories for a connected instance in the default locale (registry minus hidden entries, labels resolved). */
export const SETTINGS_CATEGORIES = entriesForScopes(['instance', 'manager'], true, 'en');
export { SETTINGS_REGISTRY };
