import { lazy, Suspense, type RefObject } from 'react';
import type { ToolContent, TranscriptEntry } from './code-types';

const MarkdownRenderer = lazy(() => import('../notes/rendering/MarkdownRenderer').then(m => ({ default: m.MarkdownRenderer })));

type CodeTranscriptProps = {
    messages: TranscriptEntry[];
    sending: boolean;
    workingDir: string;
    transcriptRef: RefObject<HTMLDivElement | null>;
};

function renderToolContent(content: ToolContent, index: number) {
    if (content.type === 'diff' && content.diff) {
        return <pre key={index} className="code-tool-diff">{content.diff}</pre>;
    }
    if (content.text) {
        return <pre key={index} className="code-tool-text">{content.text}</pre>;
    }
    return <pre key={index} className="code-tool-json">{JSON.stringify(content, null, 2)}</pre>;
}

export function CodeTranscript({ messages, sending, workingDir, transcriptRef }: CodeTranscriptProps) {
    return (
        <div className="code-transcript" ref={transcriptRef}>
            {messages.length === 0 ? (
                <div className="code-transcript-empty">
                    <p>Start a Code session by typing a prompt below.</p>
                    <p className="code-transcript-cwd">cwd: {workingDir || 'not set'}</p>
                </div>
            ) : (
                messages.map((msg, i) => (
                    <div key={i} className={`code-message code-message-${msg.role}`}>
                        {msg.role === 'tool' ? (
                            <details className={`code-tool-card code-tool-${msg.toolStatus ?? 'done'}`} open={msg.toolStatus === 'running'}>
                                <summary className="code-tool-summary">
                                    <span className={`code-tool-icon ${msg.toolStatus === 'running' ? 'spinning' : ''}`}>
                                        {msg.toolStatus === 'running' ? 'run' : 'done'}
                                    </span>
                                    <span className="code-tool-name">{msg.toolName}</span>
                                    <span className="code-tool-status">{msg.toolStatus ?? 'done'}</span>
                                </summary>
                                {(msg.toolContent?.length ?? 0) > 0 && (
                                    <div className="code-tool-content">
                                        {msg.toolContent!.map(renderToolContent)}
                                    </div>
                                )}
                                {msg.toolOutput && (
                                    <pre className="code-tool-output">{msg.toolOutput.slice(0, 2000)}{msg.toolOutput.length > 2000 ? '...' : ''}</pre>
                                )}
                            </details>
                        ) : msg.role === 'thinking' ? (
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
