import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardRegistryInstance,
    DashboardScanResult,
} from '../types';

type InstanceDetailPanelProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
    activeTab: DashboardDetailTab;
    onRegistryPatch: (port: number, patch: Partial<DashboardRegistryInstance>) => void;
};

export function InstanceDetailPanel(props: InstanceDetailPanelProps) {
    const instance = props.instance;

    return (
        <section className="detail-panel" aria-label="Selected instance detail">
                {props.activeTab === 'overview' && (
                    <div className="overview-grid">
                        <div><span>Status</span><strong>{instance?.status || 'n/a'}</strong></div>
                        <div><span>CLI</span><strong>{instance?.currentCli || 'n/a'}</strong></div>
                        <div><span>Model</span><strong>{instance?.currentModel || 'n/a'}</strong></div>
                        <div><span>Owner</span><strong>{instance?.lifecycle?.owner || 'n/a'}</strong></div>
                        <div><span>Version</span><strong>{instance?.version || 'n/a'}</strong></div>
                        <div><span>Group</span><strong>{instance?.group || 'ungrouped'}</strong></div>
                        <div><span>Reason</span><strong>{instance?.lifecycle?.reason || instance?.healthReason || 'ok'}</strong></div>
                    </div>
                )}

                {props.activeTab === 'logs' && (
                    <div className="detail-empty">
                        Logs stream is planned for phase 10.7. Recent dashboard events are available in the activity dock.
                    </div>
                )}

                {props.activeTab === 'settings' && instance && (
                    <form className="settings-form" key={instance.port} onSubmit={event => event.preventDefault()}>
                        <label>
                            Label
                            <input
                                defaultValue={instance.label || ''}
                                onBlur={event => props.onRegistryPatch(instance.port, { label: event.target.value })}
                            />
                        </label>
                        <label>
                            Group
                            <input
                                defaultValue={instance.group || ''}
                                onBlur={event => props.onRegistryPatch(instance.port, { group: event.target.value })}
                            />
                        </label>
                        <label className="toggle-control">
                            <input
                                type="checkbox"
                                checked={instance.favorite === true}
                                onChange={event => props.onRegistryPatch(instance.port, { favorite: event.target.checked })}
                            />
                            Pin favorite
                        </label>
                        <label className="toggle-control">
                            <input
                                type="checkbox"
                                checked={instance.hidden === true}
                                onChange={event => props.onRegistryPatch(instance.port, { hidden: event.target.checked })}
                            />
                            Hide by default
                        </label>
                    </form>
                )}

                {props.activeTab === 'settings' && !instance && (
                    <div className="detail-empty">
                        Select an instance to edit labels, pinned state, hidden state, and groups.
                    </div>
                )}
        </section>
    );
}
