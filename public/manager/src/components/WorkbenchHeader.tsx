import { instanceLabel } from '../instance-label';
import type { DashboardInstance } from '../types';

type WorkbenchHeaderProps = {
    instance: DashboardInstance | null;
    previewEnabled: boolean;
    onPreviewEnabledChange: (enabled: boolean) => void;
    onPreviewRefresh: () => void;
};

export function WorkbenchHeader(props: WorkbenchHeaderProps) {
    const instance = props.instance;
    const canPreview = Boolean(instance?.ok);
    const previewLabel = props.previewEnabled ? 'Preview on' : 'Preview off';

    return (
        <div className="detail-header">
            <div>
                <p className="eyebrow">Selected instance</p>
                <h2>{instance ? instanceLabel(instance) : 'No instance selected'}</h2>
                <span>{instance?.workingDir || instance?.url || 'Select an online instance to inspect it.'}</span>
            </div>
            {instance && (
                <div className="detail-header-actions">
                    <span
                        className={`preview-inline-status ${instance.ok && props.previewEnabled ? 'is-ready' : 'is-unavailable'}`}
                        aria-label={instance.ok && props.previewEnabled ? 'Preview ready' : 'Preview unavailable'}
                        title={instance.ok && props.previewEnabled ? 'Preview ready' : 'Preview unavailable'}
                    />
                    <button
                        type="button"
                        className={`preview-switch ${props.previewEnabled ? 'is-on' : 'is-off'}`}
                        role="switch"
                        aria-checked={props.previewEnabled}
                        disabled={!canPreview}
                        onClick={() => props.onPreviewEnabledChange(!props.previewEnabled)}
                    >
                        <span className="preview-switch-track" aria-hidden="true" />
                        <span>{previewLabel}</span>
                    </button>
                    <button
                        type="button"
                        className="preview-refresh-button"
                        disabled={!canPreview || !props.previewEnabled}
                        onClick={props.onPreviewRefresh}
                    >
                        Refresh
                    </button>
                    <a className="open-link" href={instance.url} target="_blank" rel="noreferrer">
                        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                        Open
                    </a>
                </div>
            )}
        </div>
    );
}
