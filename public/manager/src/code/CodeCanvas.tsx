import { useCallback, useMemo, useState } from 'react';
import { createCodeSessionClient, type CodeSession } from './code-session-client';
import { CodeSessionList } from './CodeSessionList';

type CodeCanvasProps = {
    port: number;
    workingDir: string;
};

export function CodeCanvas({ port, workingDir }: CodeCanvasProps) {
    const client = useMemo(() => createCodeSessionClient(port), [port]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [inputText, setInputText] = useState('');
    const [sending, setSending] = useState(false);
    const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);

    const handleSubmit = useCallback(async () => {
        const text = inputText.trim();
        if (!text || sending) return;
        setSending(true);
        setMessages(prev => [...prev, { role: 'user', text }]);
        setInputText('');
        try {
            let sessionId = activeSessionId;
            if (!sessionId) {
                const session = await client.createSession(workingDir);
                sessionId = session.sessionId;
                setActiveSessionId(sessionId);
            }
            await client.sendPrompt(sessionId, text);
        } catch (err) {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
        } finally {
            setSending(false);
        }
    }, [inputText, sending, activeSessionId, client, workingDir]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
        }
    }, [handleSubmit]);

    return (
        <div className="code-canvas">
            <div className="code-canvas-sidebar">
                <CodeSessionList
                    client={client}
                    activeSessionId={activeSessionId}
                    onSelectSession={setActiveSessionId}
                    onNewSession={() => setActiveSessionId(null)}
                />
            </div>
            <div className="code-canvas-main">
                <div className="code-transcript">
                    {messages.length === 0 ? (
                        <div className="code-transcript-empty">
                            <p>Start a Code session by typing a prompt below.</p>
                            <p className="code-transcript-cwd">cwd: {workingDir}</p>
                        </div>
                    ) : (
                        messages.map((msg, i) => (
                            <div key={i} className={`code-message code-message-${msg.role}`}>
                                <span className="code-message-role">{msg.role === 'user' ? 'You' : 'JWC'}</span>
                                <div className="code-message-text">{msg.text}</div>
                            </div>
                        ))
                    )}
                    {sending && <div className="code-message code-message-assistant"><span className="code-message-role">JWC</span><div className="code-message-text code-streaming">Thinking...</div></div>}
                </div>
                <div className="code-composer">
                    <textarea
                        className="code-composer-input"
                        value={inputText}
                        onChange={e => setInputText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Describe a task or ask a question..."
                        rows={1}
                        disabled={sending}
                    />
                    <button
                        type="button"
                        className="code-composer-send"
                        onClick={() => void handleSubmit()}
                        disabled={!inputText.trim() || sending}
                        aria-label="Send prompt"
                    >
                        ↑
                    </button>
                </div>
            </div>
        </div>
    );
}
