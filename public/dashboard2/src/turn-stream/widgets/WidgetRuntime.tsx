import { useEffect, useRef, useState, type JSX } from 'react';
import { validateWidgetHtml } from '../../../../js/diagram/widget-validator.ts';
import { getRenderCache } from '../render/render-cache.ts';
import type { WidgetDescriptor } from './widget-segment-adapter.ts';
import { createWidgetIframeBridge } from './widget-iframe-bridge.ts';
import { createWidgetSourceClient } from './widget-source-client.ts';

export interface WidgetRuntimeProps {
    descriptor: WidgetDescriptor;
    chatId: string;
    identity: { scopeKey: string; turnId: string; segmentId: string };
}

export function WidgetRuntime({ descriptor, chatId, identity }: WidgetRuntimeProps): JSX.Element {
    const host = useRef<HTMLDivElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [error, setError] = useState('');

    useEffect(() => {
        const client = createWidgetSourceClient();
        const bridge = createWidgetIframeBridge();
        let frame = 0;
        let registration: ReturnType<typeof bridge.create> | null = null;
        setPhase('loading');
        void client.load({
            chatId, storage: descriptor.storage, revision: descriptor.revision,
            ...(descriptor.source ? { source: descriptor.source } : {}),
            ...(descriptor.widgetId ? { widgetId: descriptor.widgetId } : {}),
        }).then(result => {
            const validation = validateWidgetHtml(result.source, { maxBytes: descriptor.storage === 'file' ? 5_242_880 : 524_288 });
            if (!validation.valid) throw new Error(validation.reason ?? 'Widget source blocked');
            if (!host.current) return;
            registration = bridge.create(result.source, {
                onResize(height) {
                    registration?.iframe.style.setProperty('height', `${height}px`);
                    if (!frame) frame = requestAnimationFrame(() => { frame = 0; getRenderCache().invalidateHeights(identity); });
                },
                onCopy(text) { void navigator.clipboard?.writeText(text); },
            });
            host.current.replaceChildren(registration.iframe);
            setPhase('ready');
        }).catch(reason => {
            if (reason instanceof Error && reason.name !== 'AbortError' && !String(reason.message).includes('cancelled')) {
                setError(reason.message); setPhase('error');
            }
        });
        return () => {
            client.cancel();
            if (frame) cancelAnimationFrame(frame);
            if (registration) bridge.destroy(registration);
            bridge.dispose();
        };
    }, [attempt, chatId, descriptor, identity]);

    return <div className="d2-widget-runtime">
        {phase === 'loading' ? <span role="status">Loading widget…</span> : null}
        {phase === 'error' ? <div role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : null}
        <div ref={host} data-widget-runtime hidden={phase === 'error'} />
    </div>;
}
