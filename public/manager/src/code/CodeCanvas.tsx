import { useCallback, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { createCodeSessionClient } from './code-session-client';
import { CodeSessionList } from './CodeSessionList';
import { ComposerFooter } from './ComposerFooter';
import { useCodeEvents, type CodeEvent } from './useCodeEvents';

const MarkdownRenderer = lazy(() => import('../notes/rendering/MarkdownRenderer').then(m => ({ default: m.MarkdownRenderer })));

type TranscriptEntry = {
    role: 'user' | 'assistant' | 'tool' | 'thinking';
    text: string;
    toolName?: string;
    toolStatus?: string;
    toolCallId?: string;
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

type PendingPermission = {
    permissionId: string;
    toolCall: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
};

export function CodeCanvas({ port, workingDir }: CodeCanvasProps) {
    const client = useMemo(() => createCodeSessionClient(port), [port]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [inputText, setInputText] = useState('');
    const [sending, setSending] = useState(false);
    const [messages, setMessages] = useState<TranscriptEntry[]>([]);
    const [permissions, setPermissions] = useState<PendingPermission[]>([]);
    const [availableCommands, setAvailableCommands] = useState<Array<{ name: string; description?: string }>>([]);
    const [showCommands, setShowCommands] = useState(false);
    const [sessionTitle, setSessionTitle] = useState('');
    const [usage, setUsage] = useState<{ contextTokens?: number; contextLimit?: number; cost?: number }>({});
    const [planEntries, setPlanEntries] = useState<Array<{ title: string; status: string }>>([]);
    const [provider, setProvider] = useState('anthropic');
    const [model, setModel] = useState('claude-fable-5');
    const [effort, setEffort] = useState('high');
    const transcriptRef = useRef<HTMLDivElement>(null);

    const handleCodeEvent = useCallback((event: CodeEvent) => {
        const update = event.update ?? {};
        const kind = event.event;

        if (kind === 'code_agent_message_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) return;
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') {
                    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                }
                return [...prev, { role: 'assistant', text }];
            });
        } else if (kind === 'code_agent_thought_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) return;
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'thinking') {
                    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                }
                return [...prev, { role: 'thinking', text }];
            });
        } else if (kind === 'code_tool_call') {
            const title = String(update['title'] ?? update['toolName'] ?? 'tool');
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? 'pending');
            setMessages(prev => [...prev, { role: 'tool', text: title, toolName: title, toolCallId, toolStatus: status === 'completed' || status === 'failed' ? 'done' : 'running' }]);
        } else if (kind === 'code_tool_call_update') {
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? '');
            if (status === 'completed' || status === 'failed') {
                setMessages(prev => {
                    const idx = prev.findLastIndex(m => m.role === 'tool' && m.toolCallId === toolCallId);
                    if (idx < 0) return prev;
                    const updated = [...prev];
                    updated[idx] = { ...updated[idx], toolStatus: 'done' };
                    return updated;
                });
            }
        } else if (kind === 'code_permission_request') {
            const permissionId = String(event['permissionId'] ?? '');
            const toolCall = (event['toolCall'] ?? {}) as Record<string, unknown>;
            const options = (event['options'] ?? []) as Array<Record<string, unknown>>;
            if (permissionId) {
                setPermissions(prev => [...prev, { permissionId, toolCall, options }]);
            }
        } else if (kind === 'code_session_info_update') {
            const title = update['title'];
            if (typeof title === 'string') setSessionTitle(title);
        } else if (kind === 'code_usage_update') {
            setUsage({
                contextTokens: typeof update['contextTokens'] === 'number' ? update['contextTokens'] : undefined,
                contextLimit: typeof update['contextLimit'] === 'number' ? update['contextLimit'] : undefined,
                cost: typeof update['totalCost'] === 'number' ? update['totalCost'] : undefined,
            });
        } else if (kind === 'code_plan') {
            const entries = (update['entries'] ?? []) as Array<{ title?: string; status?: string }>;
            setPlanEntries(entries.filter(e => e.title).map(e => ({ title: String(e.title), status: String(e.status ?? 'pending') })));
        } else if (kind === 'code_available_commands_update') {
            const cmds = (update['availableCommands'] ?? []) as Array<{ name?: string; description?: string }>;
            setAvailableCommands(cmds.filter(c => c.name).map(c => ({ name: String(c.name), description: c.description ? String(c.description) : undefined })));
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
                const cwd = workingDir || '/tmp';
                const session = await client.createSession(cwd, model);
                sessionId = session.sessionId;
                setActiveSessionId(sessionId);
            }
            await client.sendPrompt(sessionId, text);
        } catch (err) {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
            setSending(false);
        }
    }, [inputText, sending, activeSessionId, client, workingDir, model]);

    const handleInputChange = useCallback((text: string) => {
        setInputText(text);
        setShowCommands(text === '/' || (text.startsWith('/') && !text.includes(' ')));
    }, []);

    const handleCommandSelect = useCallback((name: string) => {
        setInputText(name + ' ');
        setShowCommands(false);
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Escape' && showCommands) {
            setShowCommands(false);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
        }
    }, [handleSubmit, showCommands]);

    const handlePermissionAnswer = useCallback(async (permissionId: string, optionId: string | null) => {
        try {
            await client.answerPermission(permissionId, optionId);
        } catch { /* server may have already resolved it */ }
        setPermissions(prev => prev.filter(p => p.permissionId !== permissionId));
    }, [client]);

    const modelOptions = DEFAULT_MODELS[provider] ?? DEFAULT_MODELS['anthropic'] ?? [];

    if (!port) {
        return (
            <div className="code-canvas">
                <div className="code-transcript-empty">
                    <p>Server not available.</p>
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
                    workingDir={workingDir}
                    onSelectSession={id => { setActiveSessionId(id); setMessages([]); setPlanEntries([]); setSessionTitle(''); }}
                    onLoadSession={(id, cwd) => {
                        void (async () => {
                            try {
                                await client.loadSession(id, cwd);
                                setActiveSessionId(id);
                                setMessages([]);
                                setPlanEntries([]);
                                setSessionTitle('');
                            } catch (err) {
                                setMessages(prev => [...prev, { role: 'assistant', text: `Failed to load session: ${err instanceof Error ? err.message : String(err)}` }]);
                            }
                        })();
                    }}
                    onNewSession={() => { setActiveSessionId(null); setMessages([]); setPlanEntries([]); setSessionTitle(''); }}
                />
            </div>
            <div className="code-canvas-main">
                {(sessionTitle || usage.contextTokens !== undefined || planEntries.length > 0) && (
                    <div className="code-session-header">
                        {sessionTitle && <span className="code-session-title">{sessionTitle}</span>}
                        {usage.contextTokens !== undefined && usage.contextLimit ? (
                            <span className="code-context-meter" title={`${usage.contextTokens.toLocaleString()} / ${usage.contextLimit.toLocaleString()} tokens${usage.cost !== undefined ? ` · $${usage.cost.toFixed(4)}` : ''}`}>
                                <span className="code-context-bar" style={{ width: `${Math.min(100, (usage.contextTokens / usage.contextLimit) * 100)}%` }} />
                            </span>
                        ) : null}
                        {planEntries.length > 0 && (
                            <div className="code-plan-entries">
                                {planEntries.map((e, i) => (
                                    <span key={i} className={`code-plan-entry code-plan-${e.status}`}>
                                        {e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '⚡' : '○'} {e.title}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
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
                {permissions.length > 0 && (
                    <div className="code-permissions">
                        {permissions.map(p => (
                            <div key={p.permissionId} className="code-permission-card">
                                <div className="code-permission-title">
                                    Permission: {String(p.toolCall['toolName'] ?? p.toolCall['title'] ?? 'tool')}
                                </div>
                                <div className="code-permission-actions">
                                    {p.options.length > 0 ? p.options.map((opt, i) => (
                                        <button key={i} type="button" className="code-permission-btn"
                                            onClick={() => void handlePermissionAnswer(p.permissionId, String(opt['optionId'] ?? opt['id'] ?? i))}
                                        >{String(opt['name'] ?? opt['label'] ?? `Option ${i + 1}`)}</button>
                                    )) : (
                                        <>
                                            <button type="button" className="code-permission-btn code-permission-allow"
                                                onClick={() => void handlePermissionAnswer(p.permissionId, 'allow')}
                                            >Allow</button>
                                            <button type="button" className="code-permission-btn code-permission-deny"
                                                onClick={() => void handlePermissionAnswer(p.permissionId, null)}
                                            >Deny</button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <div className="code-composer">
                    {showCommands && availableCommands.length > 0 && (
                        <div className="code-command-palette">
                            {availableCommands
                                .filter(c => !inputText || c.name.startsWith(inputText))
                                .slice(0, 10)
                                .map(c => (
                                    <button key={c.name} type="button" className="code-command-item"
                                        onClick={() => handleCommandSelect(c.name)}>
                                        <span className="code-command-name">{c.name}</span>
                                        {c.description && <span className="code-command-desc">{c.description}</span>}
                                    </button>
                                ))}
                        </div>
                    )}
                    <textarea
                        className="code-composer-input"
                        value={inputText}
                        onChange={e => handleInputChange(e.target.value)}
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
                    onProviderChange={p => {
                        setProvider(p);
                        const firstModel = (DEFAULT_MODELS[p] ?? [])[0] ?? '';
                        setModel(firstModel);
                        if (activeSessionId && firstModel) {
                            void client.setSessionModel(activeSessionId, `${p}/${firstModel}`);
                        }
                    }}
                    onModelChange={m => {
                        setModel(m);
                        if (activeSessionId) {
                            void client.setSessionModel(activeSessionId, `${provider}/${m}`);
                        }
                    }}
                    onEffortChange={e => {
                        setEffort(e);
                        if (activeSessionId) {
                            void client.setSessionConfig(activeSessionId, 'thinking', e);
                        }
                    }}
                />
            </div>
        </div>
    );
}
