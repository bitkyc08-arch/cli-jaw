import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardRegistryInstance,
    DashboardScanResult,
} from '../types';
import { SettingsShell } from '../settings/SettingsShell';
import { ProcessControlPanel } from './ProcessControlPanel';

type InstanceDetailPanelProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
    activeTab: DashboardDetailTab;
    onRegistryPatch: (port: number, patch: Partial<DashboardRegistryInstance>) => void;
    onSettingsDirtyChange?: (dirty: boolean) => void;
    onSettingsSaved?: () => void;
};

export function InstanceDetailPanel(props: InstanceDetailPanelProps) {
    const instance = props.instance;

    return (
        <section className="detail-panel" aria-label="Selected instance detail">
                {props.activeTab === 'overview' && (
                    <>
                        <div className="overview-grid">
                            <div><span>Status</span><strong>{instance?.status || 'n/a'}</strong></div>
                            <div><span>CLI</span><strong>{instance?.currentCli || 'n/a'}</strong></div>
                            <div><span>Model</span><strong>{instance?.currentModel || 'n/a'}</strong></div>
                            <div><span>Owner</span><strong>{instance?.lifecycle?.owner || 'n/a'}</strong></div>
                            <div><span>Version</span><strong>{instance?.version || 'n/a'}</strong></div>
                            <div><span>Group</span><strong>{instance?.group || 'ungrouped'}</strong></div>
                            <div><span>Reason</span><strong>{instance?.lifecycle?.reason || instance?.healthReason || 'ok'}</strong></div>
                        </div>
                        <ProcessControlPanel />
                    </>
                )}

                {props.activeTab === 'logs' && (
                    <div className="detail-empty">
                        Logs stream is planned for phase 10.7. Recent dashboard events are available in the activity dock.
                    </div>
                )}

                {props.activeTab === 'settings' && instance && (
                    <SettingsShell
                        key={instance.port}
                        port={instance.port}
                        instanceUrl={`http://localhost:${instance.port}`}
                        onDirtyChange={props.onSettingsDirtyChange}
                        onSaved={props.onSettingsSaved}
                    />
                )}

                {props.activeTab === 'settings' && !instance && (
                    <div className="detail-empty">
                        Select an instance to configure it.
                    </div>
                )}
        </section>
    );
}
