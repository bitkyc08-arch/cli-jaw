import { useId, useState } from 'react';
import { icon } from '../../../js/icons';
import { settingsIcon } from './settings-icons';
import type { SettingsCategoryId, SettingsScope } from './types';
import type { DashboardLocale } from '../types';
import { SETTINGS_REGISTRY, entriesForScopes } from './settings-registry';
import { SidebarSearch } from './components/SidebarSearch';
import { filterEntries, groupEntries } from './components/sidebar-filter';
type Props = { activeId: SettingsCategoryId; scopes: readonly SettingsScope[]; hasInstance: boolean; locale: DashboardLocale;
    onSelect: (id: SettingsCategoryId) => void; onBack?: (() => void) | undefined };
export function SettingsSidebar({activeId, scopes, hasInstance, locale, onSelect, onBack}: Props) {
    const [filter, setFilter] = useState(''); const prefix = useId();
    const entries = entriesForScopes(scopes, hasInstance, locale);
    return <nav className="settings-sidebar" aria-label="Settings categories">
        {onBack && <button type="button" className="settings-back" title="Back to workspace" onClick={onBack}>
            <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('arrowLeft', 16) }} />
            <span className="settings-nav-label">Back to workspace</span>
        </button>}
        <SidebarSearch value={filter} onChange={setFilter}/>
        {!filterEntries(entries, filter).length && <p role="status">No matches.</p>}
        {(['instance','manager'] as const).map(scope => {
            const groups = groupEntries(filterEntries(entries.filter(e=>e.scope===scope), filter));
            if (!groups.length) return null;
            return <section key={scope} aria-labelledby={`${prefix}-${scope}`}>
                <h2 className="settings-scope-label" id={`${prefix}-${scope}`}>{scope==='instance'?'Instance':'Manager'}</h2>
                {groups.map(({group,label,items})=><section key={group} className="settings-sidebar-group" aria-label={label}>
                    <h3 className="settings-sidebar-group-header">{label}</h3>
                    <div className="settings-sidebar-group-items">{items.map(entry=><button type="button" key={entry.id}
                        aria-current={entry.id===activeId?'page':undefined}
                        className={`settings-sidebar-item${entry.id===activeId?' is-active':''}`}
                        title={entry.label} onClick={()=>onSelect(entry.id)}>
                            <span className="settings-nav-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(settingsIcon(entry.id), 16) }} />
                            <span className="settings-nav-label">{entry.label}</span></button>)}</div>
                </section>)}
            </section>;
        })}
    </nav>;
}
/** Visible categories for a connected instance in the default locale (registry minus hidden entries, labels resolved). */
export const SETTINGS_CATEGORIES = entriesForScopes(['instance', 'manager'], true, 'en');
export { SETTINGS_REGISTRY };
