import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createCodeSessionClient } from './code-session-client';
import type { CodeGitInfo, CodeModelAssignment, CodeModelAssignments, CodeModelOptions, CodeModelPresetInfo, CodeSessionReplayEvent } from './code-session-client';
import { CodeCommandPopup } from './CodeCommandPopup';
import { CodeComposer } from './CodeComposer';
import { CodePermissionQueue } from './CodePermissionQueue';
import { CodeSessionList } from './CodeSessionList';
import { CodeTranscript } from './CodeTranscript';
import { CodeWorkspaceHeader } from './CodeWorkspaceHeader';
import { ComposerFooter } from './ComposerFooter';
import { FALLBACK_CODE_COMMANDS, FALLBACK_MODEL_OPTIONS, mergeCodeCommands } from './code-session-defaults';
import { findLastToolMessageIndex, normalizeCodeCommands, toModelId, type CodeCommand, type CodeCommandPopupKind, type PendingPermission, type ToolContent, type TranscriptEntry } from './code-types';
import { useCodeEvents, type CodeEvent } from './useCodeEvents';

type CodeCanvasProps = {
    port: number;
    workingDir: string;
    onWorkingDirChange?: (path: string | null) => void;
};

function normalizeToolStatus(status: string): 'running' | 'done' | 'failed' {
    const value = status.toLowerCase();
    if (value === 'failed' || value === 'error' || value === 'errored') return 'failed';
    if (value === 'completed' || value === 'done' || value === 'success') return 'done';
    return 'running';
}

function replayEventsToTranscriptEntries(events: CodeSessionReplayEvent[]): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const event of events) {
        const update = event.update ?? {};
        if (event.event === 'code_user_message_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (text) entries.push({ role: 'user', text });
        } else if (event.event === 'code_agent_message_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) continue;
            const last = entries[entries.length - 1];
            if (last?.role === 'assistant') last.text += text;
            else entries.push({ role: 'assistant', text });
        } else if (event.event === 'code_agent_thought_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) continue;
            const last = entries[entries.length - 1];
            if (last?.role === 'thinking') last.text += text;
            else entries.push({ role: 'thinking', text });
        } else if (event.event === 'code_tool_call') {
            const title = String(update['title'] ?? update['toolName'] ?? 'tool');
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? 'pending');
            const content = (update['content'] ?? []) as ToolContent[];
            entries.push({ role: 'tool', text: title, toolName: title, toolCallId, toolContent: content, toolStatus: normalizeToolStatus(status) });
        } else if (event.event === 'code_tool_call_update') {
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? '');
            const content = (update['content'] ?? []) as ToolContent[];
            const rawOutput = update['rawOutput'];
            const idx = findLastToolMessageIndex(entries, toolCallId);
            if (idx < 0) continue;
            const entry = { ...entries[idx] };
            if (status) entry.toolStatus = normalizeToolStatus(status);
            if (content.length > 0) entry.toolContent = content;
            if (rawOutput !== undefined) entry.toolOutput = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2);
            entries[idx] = entry;
        }
    }
    return entries;
}

export function CodeCanvas({ port, workingDir, onWorkingDirChange }: CodeCanvasProps) {
    const client = useMemo(() => createCodeSessionClient(port), [port]);
    const [codeWorkingDir, setCodeWorkingDir] = useState(workingDir);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [inputText, setInputText] = useState('');
    const [sending, setSending] = useState(false);
    const [messages, setMessages] = useState<TranscriptEntry[]>([]);
    const [permissions, setPermissions] = useState<PendingPermission[]>([]);
    const [availableCommands, setAvailableCommands] = useState<CodeCommand[]>(FALLBACK_CODE_COMMANDS);
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
    const [modelAssignments, setModelAssignments] = useState<CodeModelAssignments | null>(null);
    const [modelPresets, setModelPresets] = useState<CodeModelPresetInfo | null>(null);
    const [gitInfo, setGitInfo] = useState<CodeGitInfo | null>(null);
    const [sidebarHost, setSidebarHost] = useState<HTMLElement | null>(null);
    const activeSessionIdRef = useRef<string | null>(null);
    const transcriptRef = useRef<HTMLDivElement>(null);
    const selectedModelId = useMemo(() => model ? toModelId(provider, model) : '', [provider, model]);
    const latestTranscriptFootprint = useMemo(() => {
        const last = messages[messages.length - 1];
        if (!last) return 'empty';
        const toolContentSize = last.toolContent?.reduce((total, content) => total + JSON.stringify(content).length, 0) ?? 0;
        return `${messages.length}:${last.role}:${last.text.length}:${last.toolOutput?.length ?? 0}:${toolContentSize}:${last.toolStatus ?? ''}`;
    }, [messages]);

    const scrollTranscriptToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        window.requestAnimationFrame(() => {
            const node = transcriptRef.current;
            if (!node) return;
            node.scrollTo({ top: node.scrollHeight, behavior });
        });
    }, []);

    useEffect(() => {
        scrollTranscriptToBottom(messages.length > 1 ? 'smooth' : 'auto');
    }, [latestTranscriptFootprint, sending, scrollTranscriptToBottom]);

    useEffect(() => {
        if (activeSessionIdRef.current || activeSessionId) return;
        setCodeWorkingDir(workingDir);
    }, [activeSessionId, workingDir]);

    const handleWorkingDirChange = useCallback((path: string | null) => {
        if (activeSessionIdRef.current || activeSessionId) return;
        const next = path ?? '';
        setCodeWorkingDir(next);
        onWorkingDirChange?.(path);
    }, [activeSessionId, onWorkingDirChange]);

    const applyModelOptions = useCallback((options: CodeModelOptions) => {
        setModelOptions(options);
        const defaultProvider = options.providers.find(p => p.id === options.defaultProvider) ?? options.providers[0];
        const defaultModel = defaultProvider?.models.includes(options.defaultModel) ? options.defaultModel : defaultProvider?.models[0] ?? '';
        setProvider(defaultProvider?.id ?? 'anthropic');
        setModel(defaultModel);
        const nextEfforts = defaultProvider?.efforts ?? [];
        if (nextEfforts.length > 0) setEffort(nextEfforts.includes('high') ? 'high' : nextEfforts[0] ?? '');
    }, []);

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
        applyModelOptions(options);
    }, [applyModelOptions, client]);

    const refreshModelAssignments = useCallback(async () => {
        const assignments = await client.listModelAssignments();
        setModelAssignments(assignments);
    }, [client]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [options, assignments, presets] = await Promise.all([
                    client.listModelOptions(),
                    client.listModelAssignments(),
                    client.listModelPresets(),
                ]);
                if (cancelled) return;
                applyModelOptions(options);
                setModelAssignments(assignments);
                setModelPresets(presets);
            } catch (err) {
                if (!cancelled) {
                    setModelOptions({ ...FALLBACK_MODEL_OPTIONS, error: err instanceof Error ? err.message : String(err) });
                    setModelAssignments(null);
                    setModelPresets(null);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [applyModelOptions, client]);

    useEffect(() => {
        if (!codeWorkingDir) {
            setGitInfo(null);
            return;
        }
        let cancelled = false;
        void client.getGitInfo(codeWorkingDir).then(
            info => { if (!cancelled) setGitInfo(info); },
            () => { if (!cancelled) setGitInfo(null); },
        );
        return () => { cancelled = true; };
    }, [client, codeWorkingDir]);

    useEffect(() => {
        setActiveSessionId(null);
        activeSessionIdRef.current = null;
        setMessages([]);
        setPermissions([]);
        setPlanEntries([]);
        setSessionTitle('');
        setUsage({});
        setSending(false);
    }, [codeWorkingDir]);

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
        } else if (kind === 'code_user_message_chunk') {
            const content = update['content'] as { type?: string; text?: string } | undefined;
            const text = String(content?.text ?? update['text'] ?? '');
            if (!text) return;
            setMessages(prev => [...prev, { role: 'user', text }]);
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
            setMessages(prev => [...prev, { role: 'tool', text: title, toolName: title, toolCallId, toolContent: content, toolStatus: normalizeToolStatus(status) }]);
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
                if (status) entry.toolStatus = normalizeToolStatus(status);
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
            setAvailableCommands(mergeCodeCommands(normalizeCodeCommands(update['availableCommands'])));
        } else if (kind === 'code_turn_done') {
            setSending(false);
        } else if (kind === 'code_session_error') {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${event.reason ?? 'unknown'}` }]);
            setSending(false);
        }

        setTimeout(() => scrollTranscriptToBottom('smooth'), 50);
    }, [client, permissionMode, scrollTranscriptToBottom]);

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
                const cwd = codeWorkingDir || '/tmp';
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
    }, [inputText, sending, activeSessionId, client, codeWorkingDir, selectedModelId]);

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

    const handleSetDefaultModel = useCallback(async (nextProvider: string, nextModel: string) => {
        setPopupError('');
        try {
            const options = await client.setDefaultModel(toModelId(nextProvider, nextModel));
            applyModelOptions(options);
            void refreshModelAssignments();
        } catch (err) {
            setPopupError(err instanceof Error ? err.message : String(err));
        }
    }, [applyModelOptions, client, refreshModelAssignments]);

    const handleSetModelAssignment = useCallback(async (
        role: CodeModelAssignment['role'],
        nextProvider: string,
        nextModel: string,
        thinkingLevel?: string | null,
    ) => {
        setPopupError('');
        try {
            const assignments = await client.setModelAssignment(role, {
                provider: nextProvider,
                model: nextModel,
                ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
            });
            setModelAssignments(assignments);
        } catch (err) {
            setPopupError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);

    const handleClearModelAssignment = useCallback(async (role: CodeModelAssignment['role']) => {
        setPopupError('');
        try {
            const assignments = await client.clearModelAssignment(role);
            setModelAssignments(assignments);
        } catch (err) {
            setPopupError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);

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
            workingDir={codeWorkingDir}
            onSelectSession={id => { setActiveSessionId(id); setMessages([]); setPlanEntries([]); setSessionTitle(''); }}
            onLoadSession={(id, cwd) => {
                void (async () => {
                    activeSessionIdRef.current = id;
                    setActiveSessionId(id);
                    setMessages([]);
                    setPlanEntries([]);
                    setSessionTitle('');
                    try {
                        const session = await client.loadSession(id, cwd);
                        if (session.title) setSessionTitle(session.title);
                        const replayFallback = replayEventsToTranscriptEntries(session.replayEvents ?? []);
                        if (replayFallback.length > 0) {
                            setMessages(prev => prev.length > 0 ? prev : replayFallback);
                        }
                    } catch (err) {
                        if (activeSessionIdRef.current === id) {
                            activeSessionIdRef.current = null;
                            setActiveSessionId(null);
                        }
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
                    gitInfo={gitInfo}
                    modelOptions={modelOptions}
                    sessionTitle={sessionTitle}
                    usage={usage}
                    planEntries={planEntries}
                    workingDir={codeWorkingDir}
                    cwdLocked={Boolean(activeSessionId)}
                    onWorkingDirChange={handleWorkingDirChange}
                />
                <CodeTranscript messages={messages} sending={sending} workingDir={codeWorkingDir} transcriptRef={transcriptRef} />
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
                        modelAssignments={modelAssignments}
                        modelPresets={modelPresets}
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
                        onSetDefaultModel={handleSetDefaultModel}
                        onSetModelAssignment={handleSetModelAssignment}
                        onClearModelAssignment={handleClearModelAssignment}
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
