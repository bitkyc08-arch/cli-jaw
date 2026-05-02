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

function previewTargetOrigin(src: string, frame: HTMLIFrameElement | null): string | null {
    if (typeof window === 'undefined') return 'http://localhost';
    try {
        const actualOrigin = frame?.contentWindow?.location.origin;
        if (actualOrigin && actualOrigin !== 'null') return actualOrigin;
    } catch {
        // Cross-origin previews hide location; fall back to the expected source origin.
    }
    const expectedOrigin = new URL(src, window.location.href).origin;
    return expectedOrigin === 'null' ? null : expectedOrigin;
}

function postPreviewTheme(frame: HTMLIFrameElement | null, src: string, theme: PreviewTheme): void {
    const targetWindow = frame?.contentWindow;
    if (!targetWindow) return;
    const targetOrigin = previewTargetOrigin(src, frame);
    if (!targetOrigin || targetOrigin === 'null') return;
    try {
        targetWindow.postMessage(
            { type: 'jaw-preview-theme-sync', theme },
            targetOrigin,
        );
    } catch (error) {
        console.warn('[manager-preview] theme sync skipped', error);
    }
}

export function InstancePreview(props: InstancePreviewProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const loadedSrcRef = useRef<string | null>(null);
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
        if (loadedSrcRef.current !== state.src) return;
        postPreviewTheme(iframeRef.current, state.src, props.theme);
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
                    allow="clipboard-read; clipboard-write; microphone"
                    onLoad={() => {
                        loadedSrcRef.current = state.src;
                        syncTheme();
                    }}
                />
            )}

        </aside>
    );
}
