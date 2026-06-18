import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createCodeSessionClient } from './code-session-client';
import { CodeSessionList } from './CodeSessionList';
import { ComposerFooter } from './ComposerFooter';
import { useCodeEvents, type CodeEvent } from './useCodeEvents';

const MarkdownRenderer = lazy(() => import('../notes/rendering/MarkdownRenderer').then(m => ({ default: m.MarkdownRenderer })));

type ToolContent = { type: string; text?: string; diff?: string; [key: string]: unknown };

type TranscriptEntry = {
    role: 'user' | 'assistant' | 'tool' | 'thinking';
    text: string;
    toolName?: string;
    toolStatus?: string;
    toolCallId?: string;
    toolContent?: ToolContent[];
    toolOutput?: string;
};

type CodeCanvasProps = {
    port: number;
    workingDir: string;
    renderLayout?: (parts: CodeCanvasLayoutParts) => ReactNode;
};

export type CodeCanvasLayoutParts = {
    navigator: ReactNode;
    workbench: ReactNode;
};

const DEFAULT_PROVIDERS = ['anthropic'];
const DEFAULT_MODELS: Record<string, string[]> = {
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
};
const DEFAULT_EFFORTS = ['off', 'min', 'low', 'medium', 'high', 'xhigh'];

type PendingPermission = {
    permissionId: string;
    toolCall: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
};

function findLastToolMessageIndex(messages: TranscriptEntry[], toolCallId: string): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role === 'tool' && message.toolCallId === toolCallId) return i;
    }
    return -1;
}

function toModelId(provider: string, model: string): string {
    return model.includes('/') ? model : `${provider}/${model}`;
}

export function CodeCanvas({ port, workingDir, renderLayout }: CodeCanvasProps) {
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
    const [model, setModel] = useState('claude-sonnet-4-6');
    const [effort, setEffort] = useState('high');
    const [sidebarHost, setSidebarHost] = useState<HTMLElement | null>(null);
    const activeSessionIdRef = useRef<string | null>(null);
    const transcriptRef = useRef<HTMLDivElement>(null);
    const selectedModelId = useMemo(() => toModelId(provider, model), [provider, model]);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);

    useEffect(() => {
        if (renderLayout || typeof document === 'undefined') {
            setSidebarHost(null);
            return;
        }
        setSidebarHost(document.getElementById('code-session-sidebar-host'));
        return () => setSidebarHost(null);
    }, [renderLayout]);

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
            const content = (update['content'] ?? []) as ToolContent[];
            setMessages(prev => [...prev, { role: 'tool', text: title, toolName: title, toolCallId, toolContent: content, toolStatus: status === 'completed' || status === 'failed' ? 'done' : 'running' }]);
        } else if (kind === 'code_tool_call_update') {
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? '');
            const content = (update['content'] ?? []) as ToolContent[];
            const rawOutput = update['rawOutput'];
            setMessages(prev => {
                const idx = findLastToolMessageIndex(prev, toolCallId);
                if (idx < 0) return prev;
                const updated = [...prev];
                const entry = { ...updated[idx] };
                if (status === 'completed' || status === 'failed') entry.toolStatus = 'done';
                if (content.length > 0) entry.toolContent = content;
                if (rawOutput !== undefined) entry.toolOutput = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2);
                updated[idx] = entry;
                return updated;
            });
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
            const nextUsage: { contextTokens?: number; contextLimit?: number; cost?: number } = {};
            if (typeof update['contextTokens'] === 'number') nextUsage.contextTokens = update['contextTokens'];
            if (typeof update['contextLimit'] === 'number') nextUsage.contextLimit = update['contextLimit'];
            if (typeof update['totalCost'] === 'number') nextUsage.cost = update['totalCost'];
            setUsage(nextUsage);
        } else if (kind === 'code_plan') {
            const entries = (update['entries'] ?? []) as Array<{ title?: string; status?: string }>;
            setPlanEntries(entries.filter(e => e.title).map(e => ({ title: String(e.title), status: String(e.status ?? 'pending') })));
        } else if (kind === 'code_available_commands_update') {
            const cmds = (update['availableCommands'] ?? []) as Array<{ name?: string; description?: string }>;
            setAvailableCommands(cmds.filter(c => c.name).map(c => {
                const command: { name: string; description?: string } = { name: String(c.name) };
                if (c.description) command.description = String(c.description);
                return command;
            }));
        } else if (kind === 'code_turn_done') {
            setSending(false);
        } else if (kind === 'code_session_error') {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${event.reason ?? 'unknown'}` }]);
            setSending(false);
        }

        setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' }), 50);
    }, []);

    useCodeEvents({ port, sessionId: activeSessionId, sessionIdRef: activeSessionIdRef, onEvent: handleCodeEvent });

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
                const session = await client.createSession(cwd, selectedModelId);
                sessionId = session.sessionId;
                activeSessionIdRef.current = sessionId;
                setActiveSessionId(sessionId);
            }
            await client.sendPrompt(sessionId, text);
        } catch (err) {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
            setSending(false);
        }
    }, [inputText, sending, activeSessionId, client, workingDir, selectedModelId]);

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

    const sessionNavigator = (
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
    );

    const workbench = (
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
                                    <details className="code-tool-card" open={msg.toolStatus === 'running'}>
                                        <summary className="code-tool-summary">
                                            <span className={`code-tool-icon ${msg.toolStatus === 'running' ? 'spinning' : ''}`}>
                                                {msg.toolStatus === 'running' ? '⚡' : '✓'}
                                            </span>
                                            <span className="code-tool-name">{msg.toolName}</span>
                                        </summary>
                                        {(msg.toolContent?.length ?? 0) > 0 && (
                                            <div className="code-tool-content">
                                                {msg.toolContent!.map((c, ci) => (
                                                    <div key={ci} className="code-tool-content-item">
                                                        {c.type === 'diff' && c.diff ? (
                                                            <pre className="code-tool-diff">{c.diff}</pre>
                                                        ) : c.text ? (
                                                            <pre className="code-tool-text">{c.text}</pre>
                                                        ) : null}
                                                    </div>
                                                ))}
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
                            void client.setSessionModel(activeSessionId, toModelId(p, firstModel));
                        }
                    }}
                    onModelChange={m => {
                        setModel(m);
                        if (activeSessionId) {
                            void client.setSessionModel(activeSessionId, toModelId(provider, m));
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
    );

    if (renderLayout) {
        return (
            <>
                {renderLayout({
                    navigator: (
                        <section className="code-manager-session-navigator" aria-label="Code sessions">
                            {sessionNavigator}
                        </section>
                    ),
                    workbench: (
                        <div className="code-canvas code-canvas-workbench">
                            {workbench}
                        </div>
                    ),
                })}
            </>
        );
    }

    if (sidebarHost) {
        return (
            <>
                {createPortal(
                    <div className="code-manager-session-navigator-content">
                        {sessionNavigator}
                    </div>,
                    sidebarHost,
                )}
                <div className="code-canvas code-canvas-workbench">
                    {workbench}
                </div>
            </>
        );
    }

    return (
        <div className="code-canvas">
            <div className="code-canvas-sidebar">
                {sessionNavigator}
            </div>
            {workbench}
        </div>
    );
}
