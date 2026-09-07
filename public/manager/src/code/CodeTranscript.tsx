import { lazy, Suspense, useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { CodeItem, CodeProviderId } from '../../../../src/code-mode/wire';
import { useCodeTranscriptVirtualRows } from './useCodeTranscriptVirtualRows';
import { useCodeTranscriptScroll } from './use-code-transcript-scroll';
import { useThrottledMarkdown } from './use-throttled-markdown';
import { CODE_RUNTIME_LABELS, codeItemStatus } from './code-types';

const MarkdownRenderer = lazy(() => import('../notes/rendering/MarkdownRenderer').then(m => ({ default: m.MarkdownRenderer })));
function ItemMarkdown({ item, identity, onOpenLocalFile }: { item: CodeItem; identity: string; onOpenLocalFile?: ((path: string) => void) | undefined }) {
    const text = useThrottledMarkdown(item.text ?? '', item.status !== 'running' && item.status !== 'pending', identity);
    if (!text.trim()) return <span className="code-plain-text">{text}</span>;
    return <Suspense fallback={<span className="code-plain-text">{text}</span>}>
        <MarkdownRenderer markdown={text} tableMode="linear" onLocalFileOpen={onOpenLocalFile} />
    </Suspense>;
}

export function CodeTranscriptItem({ item, provider, sessionKey, onOpenLocalFile }: {
    item: CodeItem; provider: CodeProviderId; sessionKey: string; onOpenLocalFile?: ((path: string) => void) | undefined;
}) {
    const tool = item.kind === 'tool_call' || item.kind === 'file_change';
    const reasoning = item.kind === 'reasoning';
    const assistant = item.kind === 'assistant_message';
    const user = item.kind === 'user_message';
    const status = codeItemStatus(item);
    const label = user ? 'You' : assistant ? CODE_RUNTIME_LABELS[provider] : reasoning ? 'Reasoning'
        : item.kind === 'turn_started' ? 'Turn started' : item.kind === 'session_runtime' ? 'Runtime'
            : item.kind === 'permission_request' ? 'Permission record' : item.kind === 'notice' ? 'Notice' : status;
    return <article className={`code-message code-message-${tool ? 'tool' : assistant ? 'assistant' : user ? 'user' : 'system'} is-${item.status}`}
        data-code-item-id={item.itemId} aria-label={`${label} · ${status}`}>
        {tool ? <details className={`code-tool-card code-tool-${item.status}`}>
            <summary className="code-tool-summary"><span className="code-tool-chevron" aria-hidden="true">›</span>
                <span className="code-tool-name">{item.tool?.name ?? (item.kind === 'file_change' ? 'File change' : 'Tool')}</span>
                <span className="code-tool-status">{status}</span></summary>
            {item.tool?.detail !== undefined && <p className="code-tool-text">{item.tool.detail}</p>}
            {item.tool?.input !== undefined && <section className="code-tool-section"><span className="code-tool-section-label">Input</span><pre className="code-tool-args">{item.tool.input}</pre></section>}
            {item.tool?.output !== undefined && <section className="code-tool-section"><span className="code-tool-section-label">Output</span><pre className="code-tool-output">{item.tool.output}</pre></section>}
            {item.text !== undefined && <pre className="code-tool-text">{item.text}</pre>}
        </details> : reasoning ? <details className="code-thinking">
            <summary className="code-thinking-summary">Reasoning · {status}</summary><div className="code-thinking-text">{item.text}</div>
        </details> : <>
            <span className="code-message-role">{label}{assistant && item.phase && item.phase !== 'unknown' ? ` · ${item.phase === 'final' ? 'Final' : 'Commentary'}` : ''}
                {(assistant || user || item.kind === 'permission_request') && ` · ${status}`}</span>
            <div className="code-message-text">{assistant ? <ItemMarkdown item={item} identity={`${sessionKey}:${item.itemId}`} onOpenLocalFile={onOpenLocalFile} />
                : <span className="code-plain-text">{item.text ?? item.permission?.title ?? ''}</span>}</div>
            {item.permission?.detail && <p className="code-plain-text">{item.permission.detail}</p>}
        </>}
        {(assistant || reasoning) && (item.status === 'cancelled' || item.status === 'error') && <span className="code-partial-label">Partial output · {status}</span>}
        {item.truncation && <p className="code-truncation" role="note">Output truncated: {item.truncation.storedChars.toLocaleString()} of {item.truncation.sourceChars.toLocaleString()} characters retained.</p>}
    </article>;
}

export function CodeTranscript({ items, provider, sessionKey, workingDir, loading, hasOlderHistory, loadOlderHistory, permissionCount, onOpenLocalFile }: {
    items: CodeItem[]; provider: CodeProviderId; sessionKey: string; workingDir: string; loading: boolean;
    hasOlderHistory: boolean; loadOlderHistory(): Promise<void>; permissionCount: number;
    onOpenLocalFile?: ((path: string) => void) | undefined;
}) {
    const transcriptRef = useRef<HTMLDivElement>(null);
    const itemsRef = useRef(items); itemsRef.current = items;
    const [historyPending, setHistoryPending] = useState(false);
    const [historyError, setHistoryError] = useState<{ sessionKey: string; message: string } | null>(null);
    const historyGuard = useRef(false);
    const firstId = items[0]?.itemId;
    const getItemKey = useCallback((index: number) => `${sessionKey}:${itemsRef.current[index]?.itemId ?? index}`, [sessionKey, firstId]);
    const estimateSize = useCallback((index: number) => {
        const item = itemsRef.current[index];
        return item?.kind === 'tool_call' || item?.kind === 'reasoning' ? 64 : 64 + Math.min(420, (item?.text?.length ?? 0) / 6);
    }, []);
    const virtual = useCodeTranscriptVirtualRows({ count: items.length, resetKey: sessionKey, scrollElementRef: transcriptRef, getItemKey, estimateSize });
    const { showJump, jumpToLatest } = useCodeTranscriptScroll({ items, sessionKey, transcriptRef, virtual });
    async function older() {
        if (historyGuard.current) return;
        historyGuard.current = true; setHistoryPending(true); setHistoryError(null);
        try { await loadOlderHistory(); }
        catch (err) { setHistoryError({ sessionKey, message: err instanceof Error ? err.message : String(err) }); }
        finally { historyGuard.current = false; setHistoryPending(false); }
    }
    function keyboard(event: KeyboardEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
        const node = transcriptRef.current;
        if (!node) return;
        const page = Math.max(160, node.clientHeight * 0.78);
        if (['j', 'd', 'PageDown'].includes(event.key)) { event.preventDefault(); node.scrollBy({ top: page, behavior: 'auto' }); }
        else if (['k', 'u', 'PageUp'].includes(event.key)) { event.preventDefault(); node.scrollBy({ top: -page, behavior: 'auto' }); }
        else if (event.key === 'End') { event.preventDefault(); jumpToLatest(); }
        else if (event.key === 'Home') { event.preventDefault(); node.scrollTo({ top: 0, behavior: 'auto' }); }
    }
    return <>
        <div className="code-transcript-controls">
            {hasOlderHistory && <button type="button" disabled={historyPending || loading} onClick={() => void older()}>{historyPending ? 'Loading history…' : 'Load older history'}</button>}
            {showJump && <button type="button" onClick={jumpToLatest}>Jump to latest</button>}
            {permissionCount > 0 && <button type="button" onClick={() => document.getElementById('code-pending-permissions')?.focus()}>Jump to permissions ({permissionCount})</button>}
            {historyError?.sessionKey === sessionKey && <span className="code-action-error" role="alert">{historyError.message}</span>}
        </div>
        <div ref={transcriptRef} className="code-transcript" role="log" aria-label="Code transcript" aria-live="off" tabIndex={0} onKeyDown={keyboard}>
            {!items.length ? <div className="code-transcript-empty"><p>{loading ? 'Loading conversation…' : 'Type a prompt below to start this conversation.'}</p>
                <p className="code-transcript-cwd">Workspace: {workingDir || 'not set'}</p></div>
                : <div className="code-transcript-virtual-spacer" style={{ height: virtual.totalSize }}>
                    {virtual.virtualItems.map(row => {
                        const item = items[row.index];
                        return item ? <div key={row.key} ref={virtual.measureElement} className="code-transcript-virtual-row"
                            data-code-transcript-idx={row.index} style={{ transform: `translateY(${row.start}px)` }}>
                            <CodeTranscriptItem item={item} provider={provider} sessionKey={sessionKey} onOpenLocalFile={onOpenLocalFile} />
                        </div> : null;
                    })}
                </div>}
        </div>
    </>;
}
