import { memo, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useOptionalPreferences, usePreferences } from '../../providers/preferences-provider.tsx';
import { renderCopy } from '../render/copy-catalog.ts';
import {
    createParseCoalescer,
    renderFinalMarkdown,
    type MarkdownRenderResult,
    type RenderIdentity,
} from '../render/parse-coalescer.ts';
import { sanitizedHtmlProps } from '../render/sanitize-policy.ts';
import type { MarkdownSlot } from '../render/markdown-slot-manifest.ts';
import { CodeBlockSegment } from './segments/CodeBlockSegment.tsx';
import { MathSlot } from './segments/MathSlot.tsx';
import { MermaidSegment } from '../render/embeds/MermaidSegment.tsx';
import { UnifiedDiffSegment } from '../render/embeds/UnifiedDiffSegment.tsx';
import { ImageSegment } from '../render/embeds/ImageSegment.tsx';
import { FilePathLinkLayer } from '../render/links/FilePathLinkLayer.tsx';
import { LinkPreviewLayer } from '../render/links/LinkPreviewCard.tsx';
import { resolveStructuredFence } from '../render/fences/structured-fence-registry.ts';
import type { WidgetDescriptor } from '../widgets/widget-segment-adapter.ts';
import { normalizeWidgetSlot } from '../widgets/widget-segment-adapter.ts';
import { WidgetSegment } from './segments/WidgetSegment.tsx';

const OVERSIZE_BYTES = 1024 * 1024;

function StructuredSlot({ slot }: { slot: Extract<MarkdownSlot, { kind: 'structured' }> }): ReactElement {
    const resolved = resolveStructuredFence({ fenceKind: slot.fenceKind, rawSpec: slot.rawSpec, ordinal: slot.ordinal });
    if (resolved.kind === 'fallback') return <CodeBlockSegment code={resolved.escapedSource} language={slot.fenceKind} openFence={false} />;
    const Adapter = resolved.component;
    return <Adapter spec={resolved.spec as never} />;
}
function WidgetSlot({ descriptor, identity }: { descriptor: WidgetDescriptor; identity: RenderIdentity }): ReactElement {
    const [expanded, setExpanded] = useState(false);
    return <WidgetSegment descriptor={descriptor} expanded={expanded} onToggle={() => setExpanded(value => !value)} identity={identity} chatId={identity.scopeKey} />;
}

export interface MarkdownSegmentProps {
    text: string;
    identity?: RenderIdentity;
    mode?: 'final' | 'streaming';
}

function MarkdownWithSlots({ result, identity }: { result: MarkdownRenderResult; identity: RenderIdentity }): ReactElement {
    const preferences = useOptionalPreferences();
    const container = useRef<HTMLDivElement>(null);
    const [targets, setTargets] = useState(new Map<string, Element>());
    useEffect(() => {
        const next = new Map<string, Element>();
        container.current?.querySelectorAll('[data-render-slot]').forEach(element => {
            const id = element.getAttribute('data-render-slot'); if (id) next.set(id, element);
        });
        setTargets(next);
    }, [result.cacheKey, result.html]);
    const scrollRoot = container.current?.closest('.d2-turn-scroll') ?? null;
    // react-dom 19 re-sets innerHTML whenever the dangerouslySetInnerHTML
    // prop object identity changes, replacing the children and detaching the
    // captured portal targets. Memoizing the sink ELEMENT makes React bail
    // out of reconciling it entirely while the html value is unchanged, so
    // the placeholder nodes (and mounted portals) survive re-renders.
    const sink = useMemo(
        () => <div ref={container} className="markdown-segment" dangerouslySetInnerHTML={sanitizedHtmlProps(result.html)} />,
        [result.html],
    );
    return <>{sink}<FilePathLinkLayer host={container.current} revision={result.cacheKey} /><LinkPreviewLayer enabled={preferences?.hydrated === true && preferences.linkPreviews.enabled} host={container.current} revision={result.cacheKey} identity={identity} />{result.slots.map((slot: MarkdownSlot) => {
        const target = targets.get(slot.id); if (!target) return null;
        let content: ReactElement;
        if (slot.kind === 'code') content = <CodeBlockSegment code={slot.code} language={slot.language} openFence={slot.openFence} />;
        else if (slot.kind === 'math') content = <MathSlot slot={slot} scrollRoot={scrollRoot} />;
        else if (slot.kind === 'mermaid') content = <MermaidSegment source={slot.source} identity={identity} scrollRoot={scrollRoot} />;
        else if (slot.kind === 'diff') content = <UnifiedDiffSegment source={slot.source} identity={identity} />;
        else if (slot.kind === 'structured') content = <StructuredSlot slot={slot} />;
        else if (slot.kind === 'widget') { const descriptor = normalizeWidgetSlot({ kind: 'widget', ...slot.widget }); content = descriptor ? <WidgetSlot descriptor={descriptor} identity={identity} /> : <CodeBlockSegment code={slot.widget.storage === 'inline' ? slot.widget.source : slot.widget.widgetId} language="text" openFence={false} />; }
        else content = <ImageSegment src={slot.src} alt={slot.alt} title={slot.title} identity={identity} />;
        return createPortal(content, target, slot.id);
    })}</>;
}

function FinalMarkdown({ text, identity }: { text: string; identity: RenderIdentity }): ReactElement {
    const result = useMemo(() => renderFinalMarkdown(text), [text]);
    return <MarkdownWithSlots result={result} identity={identity} />;
}

function StreamingMarkdown({ text, identity }: { text: string; identity: RenderIdentity }): ReactElement {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const [snapshot, setSnapshot] = useState<MarkdownRenderResult | null>(null);
    const coalescer = useMemo(() => createParseCoalescer({
        identity,
        onPublish: setSnapshot,
    }), [identity.scopeKey, identity.turnId, identity.segmentId]);
    const latest = useRef(text);
    latest.current = text;

    useEffect(() => {
        coalescer.update(text);
        setSnapshot(coalescer.snapshot());
    }, [coalescer, text]);
    useEffect(() => () => coalescer.dispose(), [coalescer]);

    const sizeBytes = new TextEncoder().encode(text).byteLength;
    const stable = snapshot ?? coalescer.snapshot();
    if (!stable) return <div className="markdown-segment" />;
    if (sizeBytes <= OVERSIZE_BYTES) {
        return <div className="markdown-segment" dangerouslySetInnerHTML={sanitizedHtmlProps(stable.html)} />;
    }
    const tail = text.slice(stable.normalizedSource.length);
    return (
        <div className="markdown-segment--oversize">
            <div className="markdown-segment" dangerouslySetInnerHTML={sanitizedHtmlProps(stable.html)} />
            {tail ? <pre className="markdown-segment__escaped-tail">{tail}</pre> : null}
            <p role="status">{renderCopy(renderLocale, 'stream.oversizeNotice', { sizeKiB: Math.ceil(sizeBytes / 1024) })}</p>
            <button type="button" onClick={() => setSnapshot(coalescer.flushFinal(latest.current))}>
                {renderCopy(renderLocale, 'stream.renderFully')}
            </button>
        </div>
    );
}

export const MarkdownSegment = memo(function MarkdownSegment({
    text,
    identity,
    mode = 'final',
}: MarkdownSegmentProps): ReactElement {
    const localId = useId();
    const resolvedIdentity = identity ?? {
        scopeKey: 'markdown-segment',
        turnId: localId,
        segmentId: `${localId}:body`,
    };
    if (mode === 'final') return <FinalMarkdown text={text} identity={resolvedIdentity} />;
    return <StreamingMarkdown text={text} identity={resolvedIdentity} />;
});
