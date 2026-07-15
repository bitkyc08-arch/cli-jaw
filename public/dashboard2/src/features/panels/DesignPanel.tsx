import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { WidgetRuntime } from '../../turn-stream/widgets/WidgetRuntime.tsx';
import type { WidgetPanelPayload } from '../../turn-stream/widgets/widget-panel-key.ts';
import { widgetUiStore } from '../../turn-stream/widgets/widget-ui-store.ts';
import './panels.css';

export type DesignPanelPayload = { kind: 'url'; url: string } | WidgetPanelPayload;
export type DesignPanelProps = { active: boolean; payload?: DesignPanelPayload };

export function DesignPanel({ active, payload }: DesignPanelProps): JSX.Element {
    const viewportRef = useRef<HTMLDivElement>(null);
    const [revision, setRevision] = useState(0);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const widgetSnapshot = useSyncExternalStore(
        widgetUiStore.subscribe,
        widgetUiStore.getSnapshot,
        widgetUiStore.getSnapshot,
    );
    const widgetState = payload?.kind === 'widget' ? widgetSnapshot[payload.panelKey] : undefined;
    const mountWidget = payload?.kind === 'widget'
        && (widgetState?.handoff === 'mounting' || widgetState?.mode === 'panel');
    const url = payload?.kind === 'url' ? payload.url : undefined;

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!active || !viewport) return;
        const update = (): void => {
            const bounds = viewport.getBoundingClientRect();
            setSize({ width: Math.round(bounds.width), height: Math.round(bounds.height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [active]);

    useEffect(() => {
        if (payload?.kind === 'widget' && widgetState?.handoff === 'mounting') {
            widgetUiStore.promote(payload.panelKey);
        }
    }, [payload, widgetState?.handoff]);

    function openInBrowser(): void {
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }

    return (
        <section className="d2-design-panel" hidden={!active} aria-label={payload?.kind === 'widget' ? 'Widget panel' : 'Design preview'}>
            <header className="d2-panel-toolbar">
                <span className="d2-design-size" aria-label="Viewport dimensions">{size.width} × {size.height}</span>
                <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={!url}>Refresh</button>
                <button type="button" onClick={openInBrowser} disabled={!url}>Open in browser</button>
            </header>
            <div ref={viewportRef} className="d2-design-viewport">
                {mountWidget && payload?.kind === 'widget' ? (
                    // Panel ownership recreates the iframe; internal widget JS state is not preserved.
                    <WidgetRuntime descriptor={payload.descriptor} chatId={payload.chatId} identity={payload.identity} />
                ) : url ? (
                    <iframe key={`${url}:${revision}`} src={url} title="Design artifact" sandbox="allow-scripts allow-same-origin" />
                ) : payload?.kind === 'widget' ? (
                    <div className="d2-panel-state">Preparing widget panel…</div>
                ) : (
                    <div className="d2-panel-state">Open a design artifact to preview it.</div>
                )}
            </div>
        </section>
    );
}
