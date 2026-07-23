import { useEffect, useState, type JSX } from 'react';
import { fetchNoteFile } from '../notes/notes-api.ts';
import { CodeBlock } from '../notes/rendering/CodeBlock.tsx';
import { MarkdownRenderer } from '../notes/rendering/MarkdownRenderer.tsx';
import './panels.css';

export type DocPanelPayload = {
    path?: string;
    content?: string;
    truncated?: boolean;
    binary?: boolean;
};

export type DocPanelProps = {
    active: boolean;
    source: 'native-file' | 'notes';
    payload?: DocPanelPayload;
};

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

export function DocPanel({ active, source, payload = {} }: DocPanelProps): JSX.Element {
    const [content, setContent] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [message, setMessage] = useState('');
    const [copied, setCopied] = useState(false);
    const path = payload.path;
    const renderedContent = source === 'native-file' ? payload.content ?? '' : content;
    const nativeReady = source === 'native-file' && Boolean(path) && payload.binary !== true;
    const effectiveStatus = source === 'native-file' ? (nativeReady ? 'ready' : 'idle') : status;
    const markdown = Boolean(path && /\.mdx?$/i.test(path));
    const codeLanguage = markdown || !path || payload.binary ? null : languageForPath(path);

    useEffect(() => {
        if (source !== 'notes' || !active || !path) return;
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
    }, [active, path, source]);

    async function copyDocument(): Promise<void> {
        try {
            await navigator.clipboard.writeText(renderedContent);
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
                {payload.truncated ? <span className="d2-panel-state" role="status">Truncated preview</span> : null}
                <button type="button" onClick={() => void copyDocument()} disabled={effectiveStatus !== 'ready'}>
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </header>
            <div className="d2-doc-content">
                {!path ? <div className="d2-panel-state">Open a document to preview it.</div> : null}
                {payload.binary ? <div className="d2-panel-state" role="status">Binary preview is not supported.</div> : null}
                {effectiveStatus === 'loading' ? <div className="d2-panel-state" role="status">Loading document...</div> : null}
                {effectiveStatus === 'error' ? <div className="d2-panel-state is-error" role="alert">{message}</div> : null}
                {effectiveStatus === 'ready' && markdown ? <div className="d2-doc-prose"><MarkdownRenderer markdown={renderedContent} /></div> : null}
                {effectiveStatus === 'ready' && codeLanguage ? (
                    <div className="d2-doc-code"><CodeBlock code={renderedContent} language={codeLanguage} /></div>
                ) : null}
            </div>
        </section>
    );
}
