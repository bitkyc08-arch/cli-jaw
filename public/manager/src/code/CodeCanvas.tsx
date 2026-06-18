import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createCodeSessionClient } from './code-session-client';
import type { CodeGitInfo, CodeModelOptions } from './code-session-client';
import { CodeCommandPopup } from './CodeCommandPopup';
import { CodeComposer } from './CodeComposer';
import { CodePermissionQueue } from './CodePermissionQueue';
import { CodeSessionList } from './CodeSessionList';
import { CodeTranscript } from './CodeTranscript';
import { CodeWorkspaceHeader } from './CodeWorkspaceHeader';
import { ComposerFooter } from './ComposerFooter';
import { findLastToolMessageIndex, normalizeCodeCommands, toModelId, type CodeCommand, type CodeCommandPopupKind, type PendingPermission, type ToolContent, type TranscriptEntry } from './code-types';
import { useCodeEvents, type CodeEvent } from './useCodeEvents';

type CodeCanvasProps = {
    port: number;
    workingDir: string;
    onWorkingDirChange?: (path: string | null) => void;
};
const FALLBACK_MODEL_OPTIONS: CodeModelOptions = {
    providers: [{
        id: 'anthropic',
        models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
        efforts: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
    }],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    degraded: true,
};

export function CodeCanvas({ port, workingDir, onWorkingDirChange }: CodeCanvasProps) {
    const client = useMemo(() => createCodeSessionClient(port), [port]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [inputText, setInputText] = useState('');
    const [sending, setSending] = useState(false);
    const [messages, setMessages] = useState<TranscriptEntry[]>([]);
    const [permissions, setPermissions] = useState<PendingPermission[]>([]);
    const [availableCommands, setAvailableCommands] = useState<CodeCommand[]>([]);
    const [showCommands, setShowCommands] = useState(false);
    const [activePopup, setActivePopup] = useState<{ kind: CodeCommandPopupKind; command: CodeCommand } | null>(null);
    const [popupError, setPopupError] = useState('');
    const [sessionTitle, setSessionTitle] = useState('');
    const [usage, setUsage] = useState<{ contextTokens?: number; contextLimit?: number; cost?: number }>({});
    const [planEntries, setPlanEntries] = useState<Array<{ title: string; status: string }>>([]);
    const [provider, setProvider] = useState('anthropic');
    const [model, setModel] = useState('claude-sonnet-4-6');
    const [effort, setEffort] = useState('high');
    const [permissionMode, setPermissionMode] = useState('ask');
    const [modelOptions, setModelOptions] = useState<CodeModelOptions>(FALLBACK_MODEL_OPTIONS);
    const [gitInfo, setGitInfo] = useState<CodeGitInfo | null>(null);
    const [sidebarHost, setSidebarHost] = useState<HTMLElement | null>(null);
    const activeSessionIdRef = useRef<string | null>(null);
    const transcriptRef = useRef<HTMLDivElement>(null);
    const selectedModelId = useMemo(() => model ? toModelId(provider, model) : '', [provider, model]);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);

    useEffect(() => {
        if (typeof document === 'undefined') {
            setSidebarHost(null);
            return;
        }
        setSidebarHost(document.getElementById('code-session-sidebar-host'));
        return () => setSidebarHost(null);
    }, []);

    const refreshModelOptions = useCallback(async () => {
        const options = await client.listModelOptions();
        setModelOptions(options);
        const defaultProvider = options.providers.find(p => p.id === options.defaultProvider) ?? options.providers[0];
        const defaultModel = defaultProvider?.models.includes(options.defaultModel) ? options.defaultModel : defaultProvider?.models[0] ?? '';
        setProvider(defaultProvider?.id ?? 'anthropic');
        setModel(defaultModel);
        const nextEfforts = defaultProvider?.efforts ?? [];
        if (nextEfforts.length > 0) setEffort(nextEfforts.includes('high') ? 'high' : nextEfforts[0] ?? '');
    }, [client]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const options = await client.listModelOptions();
                if (cancelled) return;
                setModelOptions(options);
                const defaultProvider = options.providers.find(p => p.id === options.defaultProvider) ?? options.providers[0];
                const defaultModel = defaultProvider?.models.includes(options.defaultModel) ? options.defaultModel : defaultProvider?.models[0] ?? '';
                setProvider(defaultProvider?.id ?? 'anthropic');
                setModel(defaultModel);
                const nextEfforts = defaultProvider?.efforts ?? [];
                if (nextEfforts.length > 0) setEffort(nextEfforts.includes('high') ? 'high' : nextEfforts[0] ?? '');
            } catch (err) {
                if (!cancelled) {
                    setModelOptions({ ...FALLBACK_MODEL_OPTIONS, error: err instanceof Error ? err.message : String(err) });
                }
            }
        })();
        return () => { cancelled = true; };
    }, [client]);

    useEffect(() => {
        if (!workingDir) {
            setGitInfo(null);
            return;
        }
        let cancelled = false;
        void client.getGitInfo(workingDir).then(
            info => { if (!cancelled) setGitInfo(info); },
            () => { if (!cancelled) setGitInfo(null); },
        );
        return () => { cancelled = true; };
    }, [client, workingDir]);

    useEffect(() => {
        setActiveSessionId(null);
        activeSessionIdRef.current = null;
        setMessages([]);
        setPermissions([]);
        setPlanEntries([]);
        setSessionTitle('');
        setUsage({});
        setSending(false);
    }, [workingDir]);

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
                if (permissionMode === 'always-deny') {
                    void client.answerPermission(permissionId, null);
                    return;
                }
                if (permissionMode !== 'ask') {
                    const allowOption = options.find(opt => /allow|approve|yes/i.test(String(opt['name'] ?? opt['label'] ?? opt['optionId'] ?? opt['id'] ?? ''))) ?? options[0];
                    void client.answerPermission(permissionId, allowOption ? String(allowOption['optionId'] ?? allowOption['id'] ?? 0) : 'allow');
                    return;
                }
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
            setAvailableCommands(normalizeCodeCommands(update['availableCommands']));
        } else if (kind === 'code_turn_done') {
            setSending(false);
        } else if (kind === 'code_session_error') {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${event.reason ?? 'unknown'}` }]);
            setSending(false);
        }

        setTimeout(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' }), 50);
    }, [client, permissionMode]);

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
                const session = await client.createSession(cwd, selectedModelId || undefined);
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

    const handleCommandSelect = useCallback((command: CodeCommand) => {
        if (command.disabledReason) return;
        if (command.actionType === 'popup' && command.popupKind) {
            setPopupError('');
            setActivePopup({ kind: command.popupKind, command });
            setShowCommands(false);
            return;
        }
        setInputText(`${command.displayName} `);
        setShowCommands(false);
    }, []);

    const handlePermissionAnswer = useCallback(async (permissionId: string, optionId: string | null) => {
        try {
            await client.answerPermission(permissionId, optionId);
        } catch { /* server may have already resolved it */ }
        setPermissions(prev => prev.filter(p => p.permissionId !== permissionId));
    }, [client]);

    const handleUseModel = useCallback(async (
        nextProvider: string,
        nextModel: string,
        options?: { closePopup?: boolean; requireActiveSession?: boolean },
    ) => {
        setPopupError('');
        setProvider(nextProvider);
        setModel(nextModel);
        const closePopup = options?.closePopup ?? true;
        const requireActiveSession = options?.requireActiveSession ?? true;
        if (!activeSessionId) {
            if (requireActiveSession) setPopupError('Start or load a Code session before applying a live model.');
            return;
        }
        try {
            await client.setSessionModel(activeSessionId, toModelId(nextProvider, nextModel));
            if (closePopup) setActivePopup(null);
        } catch (err) {
            setPopupError(err instanceof Error ? err.message : String(err));
        }
    }, [activeSessionId, client]);

    const providerRecord = modelOptions.providers.find(p => p.id === provider) ?? modelOptions.providers[0];
    const providerOptions = modelOptions.providers.map(p => p.id);
    const currentModelOptions = providerRecord?.models ?? [];
    const currentEffortOptions = providerRecord?.efforts ?? [];

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
                <CodeWorkspaceHeader
                    workingDir={workingDir}
                    gitInfo={gitInfo}
                    modelOptions={modelOptions}
                    sessionTitle={sessionTitle}
                    usage={usage}
                    planEntries={planEntries}
                    onWorkingDirChange={onWorkingDirChange}
                />
                <CodeTranscript messages={messages} sending={sending} workingDir={workingDir} transcriptRef={transcriptRef} />
                <CodePermissionQueue permissions={permissions} onAnswer={(permissionId, optionId) => void handlePermissionAnswer(permissionId, optionId)} />
                <CodeComposer
                    inputText={inputText}
                    sending={sending}
                    showCommands={showCommands}
                    availableCommands={availableCommands}
                    onInputChange={handleInputChange}
                    onCommandSelect={handleCommandSelect}
                    onSubmit={() => void handleSubmit()}
                    onShowCommandsChange={setShowCommands}
                />
                {activePopup && (
                    <CodeCommandPopup
                        popupKind={activePopup.kind}
                        command={activePopup.command}
                        modelOptions={modelOptions}
                        provider={provider}
                        model={model}
                        permissionMode={permissionMode}
                        disabled={sending}
                        activeSessionId={activeSessionId}
                        error={popupError}
                        onClose={() => { setPopupError(''); setActivePopup(null); }}
                        onRefreshProviders={() => {
                            void refreshModelOptions();
                        }}
                        onProviderChange={p => {
                            setProvider(p);
                            const nextProvider = modelOptions.providers.find(entry => entry.id === p);
                            const firstModel = nextProvider?.models[0] ?? '';
                            setModel(firstModel);
                        }}
                        onUseModel={handleUseModel}
                        onPermissionModeChange={setPermissionMode}
                    />
                )}
                <ComposerFooter
                    provider={provider}
                    providerOptions={providerOptions}
                    model={model}
                    modelOptions={currentModelOptions}
                    effort={effort}
                    effortOptions={currentEffortOptions}
                    permissionMode={permissionMode}
                    disabled={sending}
                    onProviderChange={p => {
                        setProvider(p);
                        const nextProvider = modelOptions.providers.find(entry => entry.id === p);
                        const firstModel = nextProvider?.models[0] ?? '';
                        setModel(firstModel);
                        const firstEffort = nextProvider?.efforts.includes('high') ? 'high' : nextProvider?.efforts[0] ?? '';
                        setEffort(firstEffort);
                        if (firstModel) {
                            void handleUseModel(p, firstModel, { closePopup: false, requireActiveSession: false });
                        }
                    }}
                    onModelChange={m => {
                        void handleUseModel(provider, m, { closePopup: false, requireActiveSession: false });
                    }}
                    onEffortChange={e => {
                        setEffort(e);
                        if (activeSessionId) {
                            void client.setSessionConfig(activeSessionId, 'thinking', e);
                        }
                    }}
                    onPermissionModeChange={setPermissionMode}
                />
        </div>
    );

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
