import { useEffect } from 'react';
import { SettingsShell } from '../settings/SettingsShell';
import { HelpTopicButton } from '../help/HelpTopicButton';
import type { HelpTopicId } from '../help/helpContent';
import type { ManagerSettingsContext, SettingsCategoryId } from '../settings/types';
import { normalizeDashboardLocale } from '../settings/pages/manager/shared';
const IDS = { display:'manager-display', activity:'manager-activity', developer:'manager-developer',
    embedding:'manager-embedding', telegramHub:'telegram-hub' } as const satisfies Record<string, SettingsCategoryId>;
type DashboardSettingsWorkspaceProps = ManagerSettingsContext & { activeSection: keyof typeof IDS;
    port?: number; instanceUrl?: string; onDirtyChange: (dirty: boolean) => void; onSaved?: () => void;
    onOpenHelpTopic: (topic: HelpTopicId)=>void };
export function DashboardSettingsWorkspace(props: DashboardSettingsWorkspaceProps) {
    const locale = normalizeDashboardLocale(props.ui.locale);
    useEffect(()=>{ document.documentElement.lang=locale; },[locale]);
    return <main className="dashboard-settings-workspace" aria-label="Dashboard settings">
        <HelpTopicButton topic="settings" label="Open Settings help" onOpen={props.onOpenHelpTopic}/>
        <SettingsShell {...(props.port !== undefined && props.instanceUrl !== undefined ? {port:props.port,instanceUrl:props.instanceUrl} : {})}
            manager={props} onDirtyChange={props.onDirtyChange} {...(props.onSaved ? { onSaved: props.onSaved } : {})}
            scopes={props.port !== undefined ? ['instance','manager'] : ['manager']} initialId={IDS[props.activeSection]}/>
    </main>;
}
