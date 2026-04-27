import { InstancePreview } from '../InstancePreview';
import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardPreviewMode,
    DashboardScanResult,
} from '../types';

type InstanceDetailPanelProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
    activeTab: DashboardDetailTab;
    previewMode: DashboardPreviewMode;
    previewEnabled: boolean;
    onTabChange: (tab: DashboardDetailTab) => void;
    onPreviewModeChange: (mode: DashboardPreviewMode) => void;
    onPreviewEnabledChange: (enabled: boolean) => void;
};

const TABS: DashboardDetailTab[] = ['overview', 'preview', 'logs', 'settings'];

function tabLabel(tab: DashboardDetailTab): string {
    return tab[0].toUpperCase() + tab.slice(1);
}

export function InstanceDetailPanel(props: InstanceDetailPanelProps) {
    const instance = props.instance;

    return (
        <section className="detail-panel" aria-label="Selected instance detail">
            <div className="detail-header">
                <div>
                    <p className="eyebrow">Selected instance</p>
                    <h2>{instance ? `:${instance.port} ${instance.instanceId || ''}`.trim() : 'No instance selected'}</h2>
                    <span>{instance?.workingDir || instance?.url || 'Select an online instance to inspect it.'}</span>
                </div>
                {instance && <a className="open-link" href={instance.url} target="_blank" rel="noreferrer">Open</a>}
            </div>

            <div className="detail-tabs" role="tablist" aria-label="Instance detail tabs">
                {TABS.map(tab => (
                    <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={props.activeTab === tab}
                        className={props.activeTab === tab ? 'is-active' : ''}
                        onClick={() => props.onTabChange(tab)}
                    >
                        {tabLabel(tab)}
                    </button>
                ))}
            </div>

            <div className="detail-body">
                {props.activeTab === 'overview' && (
                    <div className="overview-grid">
                        <div><span>Status</span><strong>{instance?.status || 'n/a'}</strong></div>
                        <div><span>CLI</span><strong>{instance?.currentCli || 'n/a'}</strong></div>
                        <div><span>Model</span><strong>{instance?.currentModel || 'n/a'}</strong></div>
                        <div><span>Owner</span><strong>{instance?.lifecycle?.owner || 'n/a'}</strong></div>
                        <div><span>Version</span><strong>{instance?.version || 'n/a'}</strong></div>
                        <div><span>Reason</span><strong>{instance?.lifecycle?.reason || instance?.healthReason || 'ok'}</strong></div>
                    </div>
                )}

                {props.activeTab === 'preview' && (
                    <InstancePreview
                        instance={instance}
                        data={props.data}
                        mode={props.previewMode}
                        previewEnabled={props.previewEnabled}
                        onModeChange={props.onPreviewModeChange}
                        onPreviewEnabledChange={props.onPreviewEnabledChange}
                    />
                )}

                {props.activeTab === 'logs' && (
                    <div className="detail-empty">
                        Logs stream is planned for phase 10.7. Recent dashboard events are available in the activity dock.
                    </div>
                )}

                {props.activeTab === 'settings' && (
                    <div className="detail-empty">
                        Labels, favorites, hidden ports, groups, and saved selection are planned for phase 10.6.
                    </div>
                )}
            </div>
        </section>
    );
}
