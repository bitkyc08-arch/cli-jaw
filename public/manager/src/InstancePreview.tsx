import { useCallback, useEffect, useRef } from 'react';
import { buildPreviewState } from './preview';
import type { PreviewTheme } from './preview';
import type { DashboardInstance, DashboardScanResult } from './types';

type InstancePreviewProps = {
    instance: DashboardInstance | null;
    data: DashboardScanResult | null;
    enabled: boolean;
    refreshKey: number;
    theme: PreviewTheme;
};

function previewTargetOrigin(src: string): string {
    if (typeof window === 'undefined') return 'http://localhost';
    return new URL(src, window.location.href).origin;
}

export function InstancePreview(props: InstancePreviewProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const state = buildPreviewState(
        props.instance,
        props.data,
        props.theme,
    );
    const disabledReason = props.instance?.ok
        ? 'Preview is off. Turn it on from the header to mount the iframe.'
        : state.reason;
    const syncTheme = useCallback((): void => {
        if (!props.enabled || !state.canPreview || !state.src) return;
        iframeRef.current?.contentWindow?.postMessage(
            { type: 'jaw-preview-theme-sync', theme: props.theme },
            previewTargetOrigin(state.src),
        );
    }, [props.enabled, props.theme, state.canPreview, state.src]);

    useEffect(() => {
        syncTheme();
    }, [syncTheme]);

    return (
        <aside className="preview-panel" aria-label="Instance preview">
            {(!props.enabled || !state.canPreview) && <div className="preview-empty">{disabledReason}</div>}

            {props.enabled && state.canPreview && state.src && (
                <iframe
                    key={`${props.instance?.port || 'none'}:${props.refreshKey}`}
                    title={`Jaw instance ${props.instance?.port} preview`}
                    ref={iframeRef}
                    className="preview-frame"
                    src={state.src}
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-downloads"
                    allow="clipboard-read; clipboard-write; web-share"
                    onLoad={syncTheme}
                />
            )}

        </aside>
    );
}
