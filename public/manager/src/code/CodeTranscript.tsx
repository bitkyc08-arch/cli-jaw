import { lazy, Suspense, useCallback, type KeyboardEvent, type RefObject } from 'react';
import type { ToolContent, TranscriptEntry } from './code-types';
import { useCodeTranscriptVirtualRows } from './useCodeTranscriptVirtualRows';

const MarkdownRenderer = lazy(() => import('../notes/rendering/MarkdownRenderer').then(m => ({ default: m.MarkdownRenderer })));

type CodeTranscriptProps = {
    messages: TranscriptEntry[];
    sending: boolean;
    workingDir: string;
    transcriptRef: RefObject<HTMLDivElement | null>;
};

function renderToolContent(content: ToolContent, index: number) {
    const label = content.label ?? (content.type === 'args' ? 'Args' : content.type === 'output' ? 'Output' : content.type === 'error' ? 'Error' : '');
    const className = `code-tool-${content.type}`;
    const body = content.type === 'diff' && content.diff
        ? content.diff
        : content.type === 'json' || content.type === 'args'
            ? JSON.stringify(content.json ?? content, null, 2)
            : content.text ?? JSON.stringify(content, null, 2);
    if (label) {
        return (
            <div key={index} className="code-tool-section">
                <span className="code-tool-section-label">{label}</span>
                <pre className={className}>{body}</pre>
            </div>
        );
    }
    if (content.type === 'diff' && content.diff) {
        return <pre key={index} className="code-tool-diff">{content.diff}</pre>;
    }
    if (content.text) {
        return <pre key={index} className="code-tool-text">{content.text}</pre>;
    }
    return <pre key={index} className={className}>{body}</pre>;
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
}

function toolErrorSnippet(msg: TranscriptEntry): string {
    const textContent = msg.toolContent?.find(content => typeof content.text === 'string' && content.text.trim());
    const snippet = textContent?.text ?? msg.toolOutput ?? '';
    return snippet.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function firstLine(value: string): string {
    return value.split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
}

function safeToolContentLine(msg: TranscriptEntry): { name?: string; text: string } | null {
    const content = msg.toolContent?.find(item => item.type === 'args' || item.type === 'text' || item.type === 'json');
    if (!content) return null;
    if (typeof content.text === 'string') {
        const text = firstLine(content.text);
        if (!text) return null;
        return { text, ...(content.type === 'args' ? { name: 'bash' } : /^https?:\/\//.test(text) || text.startsWith('/') ? { name: 'read' } : {}) };
    }
    if (typeof content.json === 'string') {
        const text = firstLine(content.json);
        return text ? { text, ...(content.type === 'args' ? { name: 'bash' } : {}) } : null;
    }
    if (content.json && typeof content.json === 'object' && !Array.isArray(content.json)) {
        const record = content.json as Record<string, unknown>;
        for (const [key, name] of [['command', 'bash'], ['cmd', 'bash'], ['path', 'read'], ['url', 'read'], ['file', 'read'], ['query', 'search']] as const) {
            const value = record[key];
            if (typeof value === 'string' && value.trim()) return { name, text: firstLine(value) };
        }
    }
    return null;
}

function toolSummaryLabel(msg: TranscriptEntry): string {
    const name = firstLine(msg.toolName || msg.text || 'tool') || 'tool';
    const detail = safeToolContentLine(msg);
    if (name.includes(':')) return name;
    if (!detail) return name;
    if (name === 'tool') return detail.name ? `${detail.name}: ${detail.text}` : detail.text;
    return `${name}: ${detail.text}`;
}

function permissionDecisionLabel(decision: string): string {
    if (decision === 'pending') return 'Pending';
    if (decision === 'allow_once') return 'Allow once';
    if (decision === 'allow_always') return 'Always allow';
    if (decision === 'reject_once') return 'Deny once';
    if (decision === 'reject_always') return 'Always deny';
    if (decision === 'missing_option') return 'Missing JWC option';
    if (decision === 'answer_error') return 'Answer failed';
    return 'Cancelled';
}

function transcriptMessageKey(msg: TranscriptEntry, index: number): string {
    const stable = msg.toolCallId || msg.permissionAudit?.permissionId || `${msg.role}:${msg.text.slice(0, 48)}`;
    return `${index}:${stable}`;
}

function estimateTranscriptRowSize(msg: TranscriptEntry | undefined): number {
    if (!msg) return 48;
    if (msg.role === 'tool') return msg.toolStatus === 'running' ? 44 : 64 + Math.min(320, (msg.toolOutput?.length ?? 0) / 5);
    if (msg.role === 'permission') return 72;
    if (msg.role === 'thinking') return 48 + Math.min(180, msg.text.length / 8);
    return 56 + Math.min(420, msg.text.length / 6);
}

function renderCodeMessage(msg: TranscriptEntry, i: number) {
    return (
        <div key={i} className={`code-message code-message-${msg.role}`}>
            {msg.role === 'tool' ? (() => {
                const status = msg.toolStatus ?? 'done';
                const failed = status === 'failed' || status === 'error';
                const snippet = failed ? toolErrorSnippet(msg) : '';
                return (
                    <details className={`code-tool-card code-tool-${status}`} open={status === 'running' || failed}>
                        <summary className="code-tool-summary">
                            <span className="code-tool-chevron">&gt;</span>
                            <span className="code-tool-name">{toolSummaryLabel(msg)}</span>
                            <span className="code-tool-status">{status}</span>
                        </summary>
                        {snippet && <div className="code-tool-error-snippet">{snippet}</div>}
                        {(msg.toolContent?.length ?? 0) > 0 && (
                            <div className="code-tool-content">
                                {msg.toolContent!.map(renderToolContent)}
                            </div>
                        )}
                        {msg.toolOutput && (
                            <pre className="code-tool-output">{msg.toolOutput.slice(0, 2000)}{msg.toolOutput.length > 2000 ? '...' : ''}</pre>
                        )}
                    </details>
                );
            })() : msg.role === 'permission' && msg.permissionAudit ? (() => {
                const audit = msg.permissionAudit;
                const toneClass = audit.decision.startsWith('allow')
                    ? 'is-allow'
                    : audit.decision.startsWith('reject')
                        ? 'is-deny'
                        : '';
                return (
                    <div className={`code-permission-audit is-${audit.decision} ${toneClass}`.trim()}>
                        <div className="code-permission-audit-head">
                            <span>Permission</span>
                            <strong>{audit.toolName}</strong>
                            <em>{permissionDecisionLabel(audit.decision)}</em>
                        </div>
                        <div className="code-permission-audit-meta">
                            <span>mode {audit.mode}</span>
                            <span>{audit.decisionMode}</span>
                            {audit.optionId && <span>{audit.optionId}</span>}
                        </div>
                        {audit.error && <div className="code-permission-audit-error">{audit.error}</div>}
                    </div>
                );
            })() : msg.role === 'thinking' ? (
                <details className="code-thinking">
                    <summary className="code-thinking-summary">Thinking...</summary>
                    <div className="code-thinking-text">{msg.text}</div>
                </details>
            ) : (
                <>
                    <span className="code-message-role">{msg.role === 'user' ? 'You' : 'JWC'}</span>
                    <div className="code-message-text">
                        {msg.role === 'assistant' ? (
                            <Suspense fallback={<span>{msg.text}</span>}>
                                <MarkdownRenderer markdown={msg.text} tableMode="linear" />
                            </Suspense>
                        ) : msg.text}
                    </div>
                </>
            )}
        </div>
    );
}

function renderSendingMessage() {
    return (
        <div className="code-message code-message-assistant">
            <span className="code-message-role">JWC</span>
            <div className="code-message-text code-streaming">Thinking...</div>
        </div>
    );
}

export function CodeTranscript({ messages, sending, workingDir, transcriptRef }: CodeTranscriptProps) {
    const showSending = sending && messages[messages.length - 1]?.role !== 'assistant';
    const rowCount = messages.length + (showSending ? 1 : 0);
    const getItemKey = useCallback((index: number): string | number => {
        const msg = messages[index];
        return msg ? transcriptMessageKey(msg, index) : `sending-${index}`;
    }, [messages]);
    const estimateSize = useCallback((index: number): number => (
        estimateTranscriptRowSize(messages[index])
    ), [messages]);
    const virtual = useCodeTranscriptVirtualRows({
        count: rowCount,
        scrollElementRef: transcriptRef,
        getItemKey,
        estimateSize,
    });

    function handleTranscriptKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (isEditableTarget(event.target)) return;
        const node = transcriptRef.current;
        if (!node) return;
        const key = event.key.toLowerCase();
        const page = Math.max(160, Math.floor(node.clientHeight * 0.78));
        if (key === 'd' || key === 'j' || event.key === 'PageDown') {
            event.preventDefault();
            node.scrollBy({ top: page, behavior: 'smooth' });
        } else if (key === 'u' || key === 'k' || event.key === 'PageUp') {
            event.preventDefault();
            node.scrollBy({ top: -page, behavior: 'smooth' });
        } else if (event.key === 'End') {
            event.preventDefault();
            node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
        } else if (event.key === 'Home') {
            event.preventDefault();
            node.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    return (
        <div
            className="code-transcript"
            ref={transcriptRef}
            role="log"
            aria-live="polite"
            tabIndex={0}
            onKeyDown={handleTranscriptKeyDown}
        >
            {messages.length === 0 ? (
                <div className="code-transcript-empty">
                    <p>Start a Code session by typing a prompt below.</p>
                    <p className="code-transcript-cwd">cwd: {workingDir || 'not set'}</p>
                </div>
            ) : (
                <div className="code-transcript-virtual-spacer" style={{ height: `${virtual.totalSize}px` }}>
                    {virtual.virtualItems.map(virtualItem => {
                        const msg = messages[virtualItem.index];
                        return (
                            <div
                                key={virtualItem.key}
                                ref={virtual.measureElement}
                                className="code-transcript-virtual-row"
                                data-code-transcript-idx={virtualItem.index}
                                style={{ transform: `translateY(${virtualItem.start}px)` }}
                            >
                                {msg ? renderCodeMessage(msg, virtualItem.index) : renderSendingMessage()}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
