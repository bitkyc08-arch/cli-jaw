import { buildPreviewState } from './preview';
import type { DashboardInstance, DashboardPreviewMode, DashboardScanResult } from './types';

type InstancePreviewProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
    mode: DashboardPreviewMode;
    previewEnabled: boolean;
    onModeChange: (mode: DashboardPreviewMode) => void;
    onPreviewEnabledChange: (enabled: boolean) => void;
};

export function InstancePreview(props: InstancePreviewProps) {
    const state = buildPreviewState(
        props.previewEnabled ? props.instance : null,
        props.data,
        props.mode,
    );

    return (
        <aside className="preview-panel" aria-label="Instance preview">
            <div className="preview-header">
                <div>
                    <p className="eyebrow">Preview</p>
                    <h2>{props.instance ? `:${props.instance.port}` : 'No instance selected'}</h2>
                </div>
                {props.instance && (
                    <a className="open-link" href={props.instance.url} target="_blank" rel="noreferrer">
                        Open
                    </a>
                )}
            </div>

            <div className="preview-controls" aria-label="Preview controls">
                <label className="preview-toggle">
                    <input
                        type="checkbox"
                        checked={props.previewEnabled}
                        onChange={event => props.onPreviewEnabledChange(event.target.checked)}
                    />
                    Enable preview
                </label>

                <select
                    value={props.mode}
                    onChange={event => props.onModeChange(event.target.value as DashboardPreviewMode)}
                    aria-label="Preview mode"
                >
                    <option value="proxy">Proxy preview</option>
                    <option value="direct">Direct iframe</option>
                </select>
            </div>

            {!state.canPreview && <div className="preview-empty">{state.reason}</div>}

            {state.canPreview && state.src && (
                <iframe
                    title={`Jaw instance ${props.instance?.port} preview`}
                    className="preview-frame"
                    src={state.src}
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                />
            )}

            {props.mode === 'direct' && (
                <p className="preview-note">
                    Preview may be blocked by frame policy. Open the instance in a new tab or use proxy preview.
                </p>
            )}
        </aside>
    );
}
