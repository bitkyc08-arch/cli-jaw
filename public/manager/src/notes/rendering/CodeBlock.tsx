import { memo, useMemo, useState } from 'react';
import { copyText } from '../../clipboard/copy-text';
import { highlightCodeCached } from './highlight-cache';

type CodeBlockProps = {
    code: string;
    language?: string;
};

function CodeBlockImpl(props: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    // D2: highlighting used to run synchronously in the render body on every
    // parent render — i.e. on every streaming token — and again on each
    // virtualized remount. useMemo covers re-renders, the module cache covers
    // remounts, and the cache applies the oversize cutoff.
    const result = useMemo(
        () => highlightCodeCached(props.code, props.language),
        [props.code, props.language],
    );
    const label = result.language || 'text';

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
                    className={`hljs language-${label}`}
                    data-highlighted={result.highlighted ? 'yes' : 'no'}
                    dangerouslySetInnerHTML={{ __html: result.html }}
                />
            </pre>
        </div>
    );
}

export const CodeBlock = memo(CodeBlockImpl);
