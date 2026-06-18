import { lazy, Suspense, type KeyboardEvent, type RefObject } from 'react';
import type { ToolContent, TranscriptEntry } from './code-types';

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

export function CodeTranscript({ messages, sending, workingDir, transcriptRef }: CodeTranscriptProps) {
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
                messages.map((msg, i) => (
                    <div key={i} className={`code-message code-message-${msg.role}`}>
                        {msg.role === 'tool' ? (() => {
                            const status = msg.toolStatus ?? 'done';
                            const failed = status === 'failed' || status === 'error';
                            const snippet = failed ? toolErrorSnippet(msg) : '';
                            return (
                            <details className={`code-tool-card code-tool-${status}`} open={status === 'running' || failed}>
                                <summary className="code-tool-summary">
                                    <span className={`code-tool-icon ${status === 'running' ? 'spinning' : ''}`}>
                                        {status === 'running' ? 'run' : failed ? 'fail' : 'done'}
                                    </span>
                                    <span className="code-tool-name">{msg.toolName}</span>
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
                            return (
                                <div className={`code-permission-audit is-${audit.decision}`}>
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
                                            <MarkdownRenderer markdown={msg.text} />
                                        </Suspense>
                                    ) : msg.text}
                                </div>
                            </>
                        )}
                    </div>
                ))
            )}
            {sending && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="code-message code-message-assistant">
                    <span className="code-message-role">JWC</span>
                    <div className="code-message-text code-streaming">Thinking...</div>
                </div>
            )}
        </div>
    );
}
