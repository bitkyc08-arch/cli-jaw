import { useEffect, useMemo, useRef, useState } from 'react';
import { getHighlightService } from '../../../turn-stream/render/highlight-service';
import { contentHash } from '../../../turn-stream/render/render-cache';
import { sanitizedHtmlProps, type SanitizedHtml } from '../../../turn-stream/render/sanitize-policy';

async function copyText(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await navigator.clipboard.writeText(text);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

type CodeBlockProps = {
    code: string;
    language?: string;
};

export function CodeBlock(props: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    const [highlighted, setHighlighted] = useState<SanitizedHtml | null>(null);
    const generation = useRef(0);
    const codeHash = useMemo(() => contentHash(props.code), [props.code]);
    const label = props.language || 'text';

    useEffect(() => {
        const mine = ++generation.current;
        setHighlighted(null);
        const handle = getHighlightService().request(`notes:${codeHash}`, {
            code: props.code,
            codeHash,
            language: label,
            streaming: false,
            openFence: false,
            generation: mine,
            priority: 'visible',
        });
        void handle.promise.then(result => {
            if (generation.current === mine && typeof result.html === 'string') setHighlighted(result.html);
        }).catch(error => console.warn('[notes:highlight]', error));
        return () => {
            generation.current += 1;
            handle.cancel();
        };
    }, [codeHash, label, props.code]);

    async function copyCode(): Promise<void> {
        const result = await copyText(props.code);
        if (result.ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
            return;
        }
        console.error('[notes:code-copy]', result.error);
    }

    return (
        <div className="notes-code-block">
            <div className="notes-code-header">
                <button type="button" onClick={() => void copyCode()}>
                    {copied ? 'Copied' : label}
                </button>
            </div>
            <pre>
                <code
                    className={`language-${label}`}
                    data-highlighted={highlighted ? 'yes' : 'no'}
                    {...(highlighted ? { dangerouslySetInnerHTML: sanitizedHtmlProps(highlighted) } : { children: props.code })}
                />
            </pre>
        </div>
    );
}
