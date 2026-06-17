import { useCallback, useMemo, useRef, useState } from 'react';
import { createCodeSessionClient } from './code-session-client';
import { CodeSessionList } from './CodeSessionList';
import { ComposerFooter } from './ComposerFooter';
import { useCodeEvents, type CodeEvent } from './useCodeEvents';

type TranscriptEntry = {
    role: 'user' | 'assistant' | 'tool';
    text: string;
    toolName?: string;
    toolStatus?: string;
};

type CodeCanvasProps = {
    port: number;
    workingDir: string;
};

const DEFAULT_PROVIDERS = ['anthropic'];
const DEFAULT_MODELS: Record<string, string[]> = {
    anthropic: ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
};
const DEFAULT_EFFORTS = ['off', 'min', 'low', 'medium', 'high', 'xhigh'];

export function CodeCanvas({ port, workingDir }: CodeCanvasProps) {
    const client = useMemo(() => createCodeSessionClient(port), [port]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [inputText, setInputText] = useState('');
    const [sending, setSending] = useState(false);
    const [messages, setMessages] = useState<TranscriptEntry[]>([]);
    const [provider, setProvider] = useState('anthropic');
    const [model, setModel] = useState('claude-fable-5');
    const [effort, setEffort] = useState('high');
    const transcriptRef = useRef<HTMLDivElement>(null);

    const handleCodeEvent = useCallback((event: CodeEvent) => {
        const update = event.update ?? {};
        const kind = event.event;

        if (kind === 'code_text') {
            const text = String(update['text'] ?? '');
            if (!text) return;
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') {
                    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                }
                return [...prev, { role: 'assistant', text }];
            });
        } else if (kind === 'code_tool_use_begin' || kind === 'code_tool_use') {
            const toolName = String(update['toolName'] ?? update['name'] ?? 'tool');
            setMessages(prev => [...prev, { role: 'tool', text: toolName, toolName, toolStatus: 'running' }]);
        } else if (kind === 'code_tool_use_end' || kind === 'code_tool_result') {
            setMessages(prev => {
                const idx = [...prev].reverse().findIndex(m => m.role === 'tool' && m.toolStatus === 'running');
                if (idx < 0) return prev;
                const realIdx = prev.length - 1 - idx;
                const updated = [...prev];
                updated[realIdx] = { ...updated[realIdx], toolStatus: 'done' };
                return updated;
            });
        } else if (kind === 'code_turn_done') {
            setSending(false);
        } else if (kind === 'code_session_error') {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${event.reason ?? 'unknown'}` }]);
            setSending(false);
        }

        setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' }), 50);
    }, []);

    useCodeEvents({ port, sessionId: activeSessionId, onEvent: handleCodeEvent });

    const handleSubmit = useCallback(async () => {
        const text = inputText.trim();
        if (!text || sending) return;
        setSending(true);
        setMessages(prev => [...prev, { role: 'user', text }]);
        setInputText('');
        try {
            let sessionId = activeSessionId;
            if (!sessionId) {
                const session = await client.createSession(workingDir, model);
                sessionId = session.sessionId;
                setActiveSessionId(sessionId);
            }
            await client.sendPrompt(sessionId, text);
        } catch (err) {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
            setSending(false);
        }
    }, [inputText, sending, activeSessionId, client, workingDir, model]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
        }
    }, [handleSubmit]);

    const modelOptions = DEFAULT_MODELS[provider] ?? DEFAULT_MODELS['anthropic'] ?? [];

    if (!port || !workingDir) {
        return (
            <div className="code-canvas">
                <div className="code-transcript-empty">
                    <p>Select an instance to start Code mode.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="code-canvas">
            <div className="code-canvas-sidebar">
                <CodeSessionList
                    client={client}
                    activeSessionId={activeSessionId}
                    onSelectSession={id => { setActiveSessionId(id); setMessages([]); }}
                    onNewSession={() => { setActiveSessionId(null); setMessages([]); }}
                />
            </div>
            <div className="code-canvas-main">
                <div className="code-transcript" ref={transcriptRef}>
                    {messages.length === 0 ? (
                        <div className="code-transcript-empty">
                            <p>Start a Code session by typing a prompt below.</p>
                            <p className="code-transcript-cwd">cwd: {workingDir}</p>
                        </div>
                    ) : (
                        messages.map((msg, i) => (
                            <div key={i} className={`code-message code-message-${msg.role}`}>
                                {msg.role === 'tool' ? (
                                    <div className="code-tool-card">
                                        <span className={`code-tool-icon ${msg.toolStatus === 'running' ? 'spinning' : ''}`}>
                                            {msg.toolStatus === 'running' ? '⚡' : '✓'}
                                        </span>
                                        <span className="code-tool-name">{msg.toolName}</span>
                                    </div>
                                ) : (
                                    <>
                                        <span className="code-message-role">{msg.role === 'user' ? 'You' : 'JWC'}</span>
                                        <div className="code-message-text">{msg.text}</div>
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
                <ComposerFooter
                    provider={provider}
                    providerOptions={DEFAULT_PROVIDERS}
                    model={model}
                    modelOptions={modelOptions}
                    effort={effort}
                    effortOptions={DEFAULT_EFFORTS}
                    disabled={sending}
                    onProviderChange={p => { setProvider(p); setModel((DEFAULT_MODELS[p] ?? [])[0] ?? ''); }}
                    onModelChange={setModel}
                    onEffortChange={setEffort}
                />
            </div>
        </div>
    );
}
