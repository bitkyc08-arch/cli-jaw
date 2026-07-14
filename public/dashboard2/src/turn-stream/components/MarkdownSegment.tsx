import { memo, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { usePreferences } from '../../providers/preferences-provider.tsx';
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

const OVERSIZE_BYTES = 1024 * 1024;

export interface MarkdownSegmentProps {
    text: string;
    identity?: RenderIdentity;
    mode?: 'final' | 'streaming';
}

function MarkdownWithSlots({ result }: { result: MarkdownRenderResult }): ReactElement {
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
    return <>{sink}{result.slots.map((slot: MarkdownSlot) => {
        const target = targets.get(slot.id); if (!target) return null;
        return createPortal(slot.kind === 'code' ? <CodeBlockSegment code={slot.code} language={slot.language} openFence={slot.openFence} /> : <MathSlot slot={slot} scrollRoot={scrollRoot} />, target, slot.id);
    })}</>;
}

function FinalMarkdown({ text }: { text: string }): ReactElement {
    const result = useMemo(() => renderFinalMarkdown(text), [text]);
    return <MarkdownWithSlots result={result} />;
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
    if (mode === 'final') return <FinalMarkdown text={text} />;
    const resolvedIdentity = identity ?? {
        scopeKey: 'markdown-segment',
        turnId: localId,
        segmentId: `${localId}:body`,
    };
    return <StreamingMarkdown text={text} identity={resolvedIdentity} />;
});
