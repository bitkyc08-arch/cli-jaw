import { useState } from 'react';
import { highlightCode } from './highlight-languages';

type CodeBlockProps = {
    code: string;
    language?: string;
};

export function CodeBlock(props: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    const result = highlightCode(props.code, props.language);
    const label = result.language || 'text';

    async function copyCode(): Promise<void> {
        try {
            await navigator.clipboard.writeText(props.code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch (err) {
            console.error('[notes:code-copy]', err);
        }
    }

    return (
        <div className="notes-code-block">
            <div className="notes-code-header">
                <span>{label}</span>
                <button type="button" onClick={() => void copyCode()}>
                    {copied ? 'Copied' : 'Copy'}
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
