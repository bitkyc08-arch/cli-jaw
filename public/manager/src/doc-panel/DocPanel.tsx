import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getDesktop, type FolderBridgeApi } from '../panels/desktop-bridge';
import { copyText } from '../clipboard/copy-text';
import { MarkdownRenderer } from '../notes/rendering/MarkdownRenderer';
import { CodeBlock } from '../notes/rendering/CodeBlock';
import { fetchNoteFile } from '../notes/notes-api';
import './doc-panel.css';

const EXT_LANG: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cpp: 'cpp', c: 'cpp',
    css: 'css', html: 'html', xml: 'xml', json: 'json',
    yaml: 'yaml', yml: 'yaml', sh: 'bash', bash: 'bash', sql: 'sql',
};

function getFileLanguage(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext ? EXT_LANG[ext] ?? null : null;
}

function isMarkdown(filePath: string): boolean {
    return /\.(md|mdx)$/i.test(filePath);
}

function getFileBridge(): Pick<FolderBridgeApi, 'readFile' | 'getDefaultRoot'> | null {
    return getDesktop()?.folder ?? null;
}

function isNotesRelativePath(filePath: string): boolean {
    return !filePath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(filePath);
}

function getDisplayFileName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath;
}

function DocContent(props: { filePath: string; content: string; raw: boolean }) {
    if (props.raw) {
        return <pre className="doc-pre"><code>{props.content}</code></pre>;
    }
    if (isMarkdown(props.filePath)) {
        return (
            <article className="notes-preview doc-markdown">
                <MarkdownRenderer markdown={props.content} />
            </article>
        );
    }
    const lang = getFileLanguage(props.filePath);
    if (lang) {
        return <CodeBlock code={props.content} language={lang} />;
    }
    return <pre className="doc-pre"><code>{props.content}</code></pre>;
}

export function DocPanel(props: { filePath?: string | undefined }) {
    const bridge = getFileBridge();
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const contentBodyRef = useRef<HTMLDivElement | null>(null);
    const activeFilePathRef = useRef<string | undefined>(undefined);
    const scrollSnapshotRef = useRef({ filePath: '', scrollTop: 0 });
    const resizeRestoreRef = useRef<number | null>(null);
    const copiedTimerRef = useRef<number | null>(null);
    const [content, setContent] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [binary, setBinary] = useState(false);
    const [truncated, setTruncated] = useState(false);
    const [raw, setRaw] = useState(false);
    const [copiedAction, setCopiedAction] = useState<'path' | 'content' | null>(null);

    const markCopied = useCallback((action: 'path' | 'content') => {
        if (copiedTimerRef.current !== null) {
            window.clearTimeout(copiedTimerRef.current);
        }
        setCopiedAction(action);
        copiedTimerRef.current = window.setTimeout(() => {
            copiedTimerRef.current = null;
            setCopiedAction(current => current === action ? null : current);
        }, 1200);
    }, []);

    const copyPath = useCallback(() => {
        const filePath = props.filePath;
        if (!filePath) return;
        void copyText(filePath).then(result => {
            if (result.ok) markCopied('path');
            else console.error('[doc-panel:path-copy]', result.error);
        });
    }, [markCopied, props.filePath]);

    const copyContent = useCallback(() => {
        void copyText(content).then(result => {
            if (result.ok) markCopied('content');
            else console.error('[doc-panel:content-copy]', result.error);
        });
    }, [content, markCopied]);

    const scheduleScrollRestore = useCallback((filePath: string) => {
        if (resizeRestoreRef.current !== null) {
            cancelAnimationFrame(resizeRestoreRef.current);
        }
        const top = scrollSnapshotRef.current.filePath === filePath
            ? scrollSnapshotRef.current.scrollTop
            : 0;
        resizeRestoreRef.current = requestAnimationFrame(() => {
            resizeRestoreRef.current = null;
            const node = scrollRef.current;
            if (!node || scrollSnapshotRef.current.filePath !== filePath) return;
            node.scrollTop = top;
        });
    }, []);

    useEffect(() => {
        if (!props.filePath) {
            setContent('');
            setError(null);
            setTruncated(false);
            setCopiedAction(null);
            setRaw(false);
            return;
        }
        const filePath = props.filePath;
        let cancelled = false;
        setCopiedAction(null);
        setRaw(false);
        void (async () => {
            if (bridge) {
                let result = await bridge.readFile(filePath);
                // Cold start: DocPanel may seed the default allowlisted root
                // for direct preview links, then retry once.
                if (!result.ok && result.error?.includes('path not allowed')) {
                    await bridge.getDefaultRoot();
                    if (cancelled) return;
                    result = await bridge.readFile(filePath);
                }
                if (cancelled) return;
                if (result.ok && result.content !== undefined) {
                    setBinary(result.binary === true);
                    setTruncated(result.truncated === true && result.binary !== true);
                    setContent(result.binary || result.truncated ? '' : result.content);
                    setError(null);
                } else {
                    setError(result.error ?? 'Failed to read file');
                }
                return;
            }
            if (!isNotesRelativePath(filePath)) {
                if (!cancelled) setError('Document preview for arbitrary local files requires Electron desktop app');
                return;
            }
            try {
                const note = await fetchNoteFile(filePath);
                if (cancelled) return;
                setBinary(false);
                setTruncated(false);
                setContent(note.content);
                setError(null);
            } catch (err) {
                if (!cancelled) setError((err as Error).message);
            }
        })();
        return () => { cancelled = true; };
    }, [bridge, props.filePath]);

    useLayoutEffect(() => {
        const node = scrollRef.current;
        const filePath = props.filePath;
        if (!node || !filePath) return;
        if (activeFilePathRef.current !== filePath) {
            activeFilePathRef.current = filePath;
            node.scrollTop = 0;
            scrollSnapshotRef.current = { filePath, scrollTop: 0 };
            return;
        }
        scheduleScrollRestore(filePath);
    }, [content, props.filePath, scheduleScrollRestore]);

    useEffect(() => {
        const body = contentBodyRef.current;
        const filePath = props.filePath;
        if (!body || !filePath) return undefined;

        const observer = new ResizeObserver(() => {
            if (scrollSnapshotRef.current.filePath !== filePath) return;
            scheduleScrollRestore(filePath);
        });
        observer.observe(body);
        return () => {
            observer.disconnect();
        };
    }, [content, props.filePath, scheduleScrollRestore]);

    useEffect(() => () => {
        if (resizeRestoreRef.current !== null) {
            cancelAnimationFrame(resizeRestoreRef.current);
            resizeRestoreRef.current = null;
        }
        if (copiedTimerRef.current !== null) {
            window.clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = null;
        }
    }, []);

    if (!props.filePath) {
        return <div className="doc-panel doc-empty">Open Folders and select a file to preview it here.</div>;
    }

    if (error) {
        return <div className="doc-panel doc-error">{error}</div>;
    }

    if (binary) {
        return <div className="doc-panel doc-binary">Binary file — cannot preview</div>;
    }

    if (truncated) {
        return <div className="doc-panel doc-binary">File too large to preview (512KB cap) — open it in an editor instead.</div>;
    }

    return (
        <div className="doc-panel">
            <div className="doc-toolbar">
                <span className="doc-file-name" title={props.filePath}>{getDisplayFileName(props.filePath)}</span>
                <div className="doc-toolbar-actions" aria-label="Document actions">
                    <button
                        type="button"
                        className={`doc-toolbar-button ${raw ? 'is-active' : ''}`}
                        aria-pressed={raw}
                        title="Show raw source"
                        onClick={() => setRaw(value => !value)}
                    >
                        Raw
                    </button>
                    <button
                        type="button"
                        className="doc-toolbar-button"
                        title="Copy full path"
                        onClick={copyPath}
                    >
                        {copiedAction === 'path' ? 'Copied' : 'Path'}
                    </button>
                    <button
                        type="button"
                        className="doc-toolbar-button"
                        title="Copy file content"
                        onClick={copyContent}
                    >
                        {copiedAction === 'content' ? 'Copied' : 'Copy'}
                    </button>
                </div>
            </div>
            <div
                className="doc-content"
                ref={scrollRef}
                onScroll={(event) => {
                    if (!props.filePath) return;
                    scrollSnapshotRef.current = {
                        filePath: props.filePath,
                        scrollTop: event.currentTarget.scrollTop,
                    };
                }}
            >
                <div className="doc-content-body" ref={contentBodyRef}>
                    <DocContent filePath={props.filePath} content={content} raw={raw} />
                </div>
            </div>
        </div>
    );
}
