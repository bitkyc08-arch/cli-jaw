import { useEffect, useMemo, useState, type JSX } from 'react';
import { fetchNoteFile } from '../notes/notes-api.ts';
import { MarkdownRenderer } from '../notes/rendering/MarkdownRenderer.tsx';
import { highlightCode } from '../notes/rendering/highlight-languages.ts';
import './panels.css';

export type DocPanelProps = { active: boolean; path?: string };

const EXT_LANG: Record<string, string> = {
    c: 'c', cpp: 'cpp', css: 'css', go: 'go', h: 'c', html: 'html', java: 'java',
    js: 'javascript', json: 'json', jsx: 'javascript', md: 'markdown', py: 'python',
    rs: 'rust', sh: 'bash', sql: 'sql', ts: 'typescript', tsx: 'typescript',
    xml: 'xml', yaml: 'yaml', yml: 'yaml',
};

function languageForPath(path: string): string {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    return EXT_LANG[extension] ?? 'text';
}

export function DocPanel({ active, path }: DocPanelProps): JSX.Element {
    const [content, setContent] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [message, setMessage] = useState('');
    const [copied, setCopied] = useState(false);
    const markdown = Boolean(path && /\.mdx?$/i.test(path));
    const highlighted = useMemo(
        () => markdown || !path ? null : highlightCode(content, languageForPath(path)),
        [content, markdown, path],
    );

    useEffect(() => {
        if (!active || !path) return;
        const controller = new AbortController();
        setStatus('loading');
        setMessage('');
        void fetchNoteFile(path).then((file) => {
            if (controller.signal.aborted) return;
            setContent(file.content);
            setStatus('ready');
        }).catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setMessage(error instanceof Error ? error.message : 'Unable to load document');
            setStatus('error');
        });
        return () => controller.abort();
    }, [active, path]);

    async function copyDocument(): Promise<void> {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch (error) {
            console.error('[dashboard2:doc-copy]', error);
        }
    }

    return (
        <section className="d2-doc-panel" hidden={!active} aria-label="Document viewer">
            <header className="d2-panel-toolbar">
                <span className="d2-panel-path" title={path}>{path ?? 'No document selected'}</span>
                <button type="button" onClick={() => void copyDocument()} disabled={status !== 'ready'}>
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </header>
            <div className="d2-doc-content">
                {!path ? <div className="d2-panel-state">Open a document to preview it.</div> : null}
                {status === 'loading' ? <div className="d2-panel-state" role="status">Loading document...</div> : null}
                {status === 'error' ? <div className="d2-panel-state is-error" role="alert">{message}</div> : null}
                {status === 'ready' && markdown ? <div className="d2-doc-prose"><MarkdownRenderer markdown={content} /></div> : null}
                {status === 'ready' && highlighted ? (
                    <pre className="d2-doc-code"><code className={`hljs language-${highlighted.language}`} dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
                ) : null}
            </div>
        </section>
    );
}
