import { buildPreviewState } from './preview';
import type { DashboardInstance, DashboardScanResult } from './types';

type InstancePreviewProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
};

export function InstancePreview(props: InstancePreviewProps) {
    const state = buildPreviewState(
        props.instance,
        props.data,
    );

    return (
        <aside className="preview-panel" aria-label="Instance preview">
            {!state.canPreview && <div className="preview-empty">{state.reason}</div>}

            {state.canPreview && state.src && (
                <iframe
                    title={`Jaw instance ${props.instance?.port} preview`}
                    className="preview-frame"
                    src={state.src}
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                />
            )}

        </aside>
    );
}
