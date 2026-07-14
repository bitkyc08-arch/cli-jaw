import { memo, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { usePreferences } from '../../providers/preferences-provider.tsx';
import { renderCopy } from '../render/copy-catalog.ts';
import {
    createParseCoalescer,
    renderFinalMarkdown,
    type MarkdownRenderResult,
    type RenderIdentity,
} from '../render/parse-coalescer.ts';
import { sanitizedHtmlProps } from '../render/sanitize-policy.ts';

const OVERSIZE_BYTES = 1024 * 1024;

export interface MarkdownSegmentProps {
    text: string;
    identity?: RenderIdentity;
    mode?: 'final' | 'streaming';
}

function FinalMarkdown({ text }: { text: string }): ReactElement {
    const result = useMemo(() => renderFinalMarkdown(text), [text]);
    return <div className="markdown-segment" dangerouslySetInnerHTML={sanitizedHtmlProps(result.html)} />;
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
