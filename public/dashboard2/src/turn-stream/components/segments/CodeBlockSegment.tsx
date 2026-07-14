import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { usePreferences } from '../../../providers/preferences-provider.tsx';
import { renderCopy } from '../../render/copy-catalog.ts';
import { getHighlightService } from '../../render/highlight-service.ts';
import { sanitizedHtmlProps, type SanitizedHtml } from '../../render/sanitize-policy.ts';

export interface CodeBlockSegmentProps {
    code: string;
    language: string;
    openFence: boolean;
    streaming?: boolean;
}

type HighlightState =
    | { kind: 'plain' }
    | { kind: 'pending' }
    | { kind: 'highlighted'; html: SanitizedHtml }
    | { kind: 'manual'; sizeKiB: number }
    | { kind: 'error'; message: string };

const MANUAL_BYTES = 200 * 1024;

function sourceHash(source: string): string {
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16);
}

export function CodeBlockSegment({ code, language, openFence, streaming = false }: CodeBlockSegmentProps): ReactElement {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const [wrap, setWrap] = useState(false);
    const [copied, setCopied] = useState(false);
    const [manualRequested, setManualRequested] = useState(false);
    const [state, setState] = useState<HighlightState>({ kind: 'plain' });
    const generation = useRef(0);
    const codeHash = useMemo(() => sourceHash(code), [code]);
    const sizeKiB = Math.ceil(new TextEncoder().encode(code).byteLength / 1024);

    useEffect(() => {
        const mine = ++generation.current;
        if (streaming || openFence) { setState({ kind: 'plain' }); return; }
        if (sizeKiB > 200 && !manualRequested) { setState({ kind: 'manual', sizeKiB }); return; }
        setState({ kind: 'pending' });
        const handle = getHighlightService().request(`code-slot:${codeHash}`, {
            code, codeHash, language, streaming, openFence, generation: mine,
            priority: manualRequested ? 'manual' : 'visible',
        });
        void handle.promise.then(result => {
            if (generation.current !== mine) return;
            if (typeof result.html === 'string') setState({ kind: 'highlighted', html: result.html });
            else if (result.error) setState({ kind: 'error', message: result.error });
            else setState({ kind: 'plain' });
        }).catch(error => {
            if (generation.current === mine) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Highlight failed' });
        });
        return () => { generation.current += 1; handle.cancel(); };
    }, [code, codeHash, language, manualRequested, openFence, sizeKiB, streaming]);

    const copy = async (): Promise<void> => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
    };
    const wrapKey = wrap ? 'code.nowrap' : 'code.wrap';
    return (
        <figure className={`d2-code-block${wrap ? ' is-wrapped' : ''}`} data-highlight-state={state.kind}>
            <figcaption className="d2-code-block__header">
                <span className="d2-code-block__language">{language || 'plaintext'}</span>
                <span className="d2-code-block__controls">
                    {state.kind === 'manual' ? <button type="button" onClick={() => setManualRequested(true)} aria-label={renderCopy(renderLocale, 'code.highlight')} title={renderCopy(renderLocale, 'code.oversize', { sizeKiB: state.sizeKiB })}>{renderCopy(renderLocale, 'code.highlight')}</button> : null}
                    <button type="button" onClick={() => setWrap(value => !value)} aria-pressed={wrap} aria-label={renderCopy(renderLocale, wrapKey)} title={renderCopy(renderLocale, wrapKey)}>{renderCopy(renderLocale, wrapKey)}</button>
                    <button type="button" onClick={() => void copy()} aria-label={renderCopy(renderLocale, 'code.copy')} title={renderCopy(renderLocale, 'code.copy')}>{renderCopy(renderLocale, 'code.copy')}</button>
                </span>
            </figcaption>
            <div className="d2-code-block__status" aria-live="polite">
                {copied ? renderCopy(renderLocale, 'code.copied') : state.kind === 'pending' ? renderCopy(renderLocale, 'code.highlighting') : state.kind === 'error' ? renderCopy(renderLocale, 'code.plain') : ''}
            </div>
            <pre className="d2-code-block__pre"><code {...(state.kind === 'highlighted' ? { dangerouslySetInnerHTML: sanitizedHtmlProps(state.html) } : { children: code })} /></pre>
        </figure>
    );
}
