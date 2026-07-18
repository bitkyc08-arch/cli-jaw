import type { SettingsClient } from '../settings/types';
import type { DockSettingsSnapshot } from './HoverDock';
import { SettingsPromptSection } from './SettingsPromptSection';
import { SettingsChannelsSection } from './SettingsChannelsSection';
import { SettingsModelsSection } from './SettingsModelsSection';
import { SettingsMcpSection } from './SettingsMcpSection';
import { SettingsSttSection } from './SettingsSttSection';

type SettingsTabProps = {
    client: SettingsClient;
    active: boolean;
    snapshot: DockSettingsSnapshot;
};

export function SettingsTab({ client, active, snapshot }: SettingsTabProps) {
    const { state } = snapshot;
    if (state.kind === 'offline') return <div className="dock-error">인스턴스 오프라인</div>;
    if (state.kind === 'error') return <div className="dock-error">{state.message}</div>;
    if (state.kind !== 'ready') return <div className="dock-loading">로딩 중...</div>;
    return (
        <div className="dock-settings">
            <SettingsPromptSection client={client} active={active} />
            <SettingsChannelsSection client={client} active={active} settings={state.data} snapshot={snapshot} />
            <SettingsModelsSection client={client} active={active} settings={state.data} snapshot={snapshot} />
            <SettingsMcpSection client={client} active={active} />
            <SettingsSttSection client={client} active={active} settings={state.data} snapshot={snapshot} />
        </div>
    );
}
