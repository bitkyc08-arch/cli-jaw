import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createCodeSessionClient } from './code-session-client';
import type { CodeGitInfo, CodeModelAssignment, CodeModelAssignments, CodeModelOptions, CodeModelPresetInfo } from './code-session-client';
import { CodeSessionList } from './CodeSessionList';
import { CodeWorkbench } from './CodeWorkbench';
import { getDesktop } from '../panels/desktop-bridge';
import { FALLBACK_CODE_COMMANDS, FALLBACK_MODEL_OPTIONS, mergeCodeCommands } from './code-session-defaults';
import {
    findLastToolMessageIndex,
    normalizeCodeCommands,
    normalizeToolContentFromUpdate,
    toModelId,
    type CodeCommand,
    type CodeCommandPopupKind,
    type PendingPermission,
    type PermissionMode,
    type PermissionOptionKind,
    type TranscriptEntry,
} from './code-types';
import { answerQueuedPermission, handleIncomingPermissionRequest } from './code-permission-flow';
import { normalizeToolStatus, replayEventsToTranscriptEntries } from './code-transcript-replay';
import { useCodeTranscriptScroll } from './use-code-transcript-scroll';
import { useCodeEvents, type CodeEvent, type CodeTransportState } from './useCodeEvents';

type CodeCanvasProps = {
    port: number;
    workingDir: string;
    onWorkingDirChange?: (path: string | null) => void;
};

export function CodeCanvas({ port, workingDir, onWorkingDirChange }: CodeCanvasProps) {
    const client = useMemo(() => createCodeSessionClient(port), [port]);
    const [codeWorkingDir, setCodeWorkingDir] = useState(workingDir);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [workspaceFrozen, setWorkspaceFrozen] = useState(false);
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
    const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
    const [modelOptions, setModelOptions] = useState<CodeModelOptions>(FALLBACK_MODEL_OPTIONS);
    const [modelAssignments, setModelAssignments] = useState<CodeModelAssignments | null>(null);
    const [modelPresets, setModelPresets] = useState<CodeModelPresetInfo | null>(null);
    const [gitInfo, setGitInfo] = useState<CodeGitInfo | null>(null);
    const [childRecovery, setChildRecovery] = useState<{ code: string; message: string } | null>(null);
    const [transportState, setTransportState] = useState<CodeTransportState>('connected');
    const [sidebarHost, setSidebarHost] = useState<HTMLElement | null>(null);
    const activeSessionIdRef = useRef<string | null>(null);
    const selectedModelId = useMemo(() => model ? toModelId(provider, model) : '', [provider, model]);
    const { transcriptRef, scrollTranscriptToBottom } = useCodeTranscriptScroll(messages, sending, Boolean(activePopup));

    useEffect(() => {
        if (activeSessionIdRef.current || activeSessionId) return;
        setCodeWorkingDir(workingDir);
    }, [activeSessionId, workingDir]);

    const handleWorkingDirChange = useCallback((path: string | null) => {
        // slice 213: cwd is locked once a session is active OR the workspace is frozen
        // (first Send sent, createSession not yet resolved — the FrozenStarting window).
        if (activeSessionIdRef.current || activeSessionId || workspaceFrozen) return;
        const next = path ?? '';
        setCodeWorkingDir(next);
        onWorkingDirChange?.(path);
    }, [activeSessionId, onWorkingDirChange, workspaceFrozen]);

    // Slice 210: pick a Code workspace folder. Electron uses the native bridge;
    // the Web Manager falls back to the /api/code/workspace/pick OS dialog.
    // Returns the chosen absolute path, or null if cancelled/unavailable.
    const handlePickWorkspace = useCallback(async (): Promise<string | null> => {
        const desktop = getDesktop();
        if (desktop?.folder?.pickFolder) {
            const result = await desktop.folder.pickFolder();
            if (result.ok && result.path) return result.path;
            if (result.error && result.error !== 'cancelled') throw new Error(result.error);
            return null;
        }
        const result = await client.pickWorkspace();
        return result.ok && result.path ? result.path : null;
    }, [client]);

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
        setChildRecovery(null);
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
            const content = normalizeToolContentFromUpdate(update);
            setMessages(prev => [...prev, { role: 'tool', text: title, toolName: title, toolCallId, toolContent: content, toolStatus: normalizeToolStatus(status) }]);
        } else if (kind === 'code_tool_call_update') {
            const toolCallId = String(update['toolCallId'] ?? '');
            const status = String(update['status'] ?? '');
            const content = normalizeToolContentFromUpdate(update);
            setMessages(prev => {
                const idx = findLastToolMessageIndex(prev, toolCallId);
                if (idx < 0) return prev;
                const updated = [...prev];
                const entry = { ...updated[idx] };
                if (status) entry.toolStatus = normalizeToolStatus(status);
                if (content.length > 0) entry.toolContent = content;
                updated[idx] = entry;
                return updated;
            });
        } else if (kind === 'code_permission_request') {
            const permissionId = String(event['permissionId'] ?? '');
            const toolCall = (event['toolCall'] ?? {}) as Record<string, unknown>;
            const options = (event['options'] ?? []) as Array<Record<string, unknown>>;
            if (permissionId) {
                const pending: PendingPermission = { permissionId, toolCall, options };
                handleIncomingPermissionRequest(client, permissionMode, pending, {
                    appendMessage: entry => setMessages(prev => [...prev, entry]),
                    enqueuePermission: permission => setPermissions(prev => [...prev, permission]),
                });
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
        } else if (kind === 'code_child_exit') {
            const code = event['code'] === null || event['code'] === undefined ? 'unknown' : String(event['code']);
            const message = `JWC ACP child exited (code ${code}). Active Code sessions were closed. Send the prompt again to start a fresh session, or load a stored session from the sidebar.`;
            activeSessionIdRef.current = null;
            setActiveSessionId(null);
            setSending(false);
            setPermissions([]);
            setChildRecovery({ code, message });
            setMessages(prev => [...prev, { role: 'assistant', text: message }]);
        } else if (kind === 'code_turn_done') {
            setSending(false);
        } else if (kind === 'code_session_error') {
            setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${event.reason ?? 'unknown'}` }]);
            setSending(false);
        }

        setTimeout(() => scrollTranscriptToBottom('smooth'), 50);
    }, [client, permissionMode, scrollTranscriptToBottom]);

    useCodeEvents({ port, sessionId: activeSessionId, sessionIdRef: activeSessionIdRef, onEvent: handleCodeEvent, onTransport: setTransportState });

    const handleSubmit = useCallback(async () => {
        const text = inputText.trim();
        if (!text || sending) return;
        setSending(true);
        setWorkspaceFrozen(true); // slice 210: freeze cwd on first Send, before createSession; stays frozen on failure
        setChildRecovery(null);
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

    const handlePermissionAnswer = useCallback(async (permission: PendingPermission, action: PermissionOptionKind) => {
        const answered = await answerQueuedPermission(
            client,
            permissionMode,
            permission,
            action,
            entry => setMessages(prev => [...prev, entry]),
        );
        if (answered) setPermissions(prev => prev.filter(p => p.permissionId !== permission.permissionId));
    }, [client, permissionMode]);

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
            onNewSession={() => { setActiveSessionId(null); setMessages([]); setPlanEntries([]); setSessionTitle(''); setWorkspaceFrozen(false); }}
        />
    );

    const handleProviderChange = (p: string) => {
        setProvider(p);
        const nextProvider = modelOptions.providers.find(entry => entry.id === p);
        const firstModel = nextProvider?.models[0] ?? '';
        setModel(firstModel);
    };
    const handleFooterProviderChange = (p: string) => {
        handleProviderChange(p);
        const nextProvider = modelOptions.providers.find(entry => entry.id === p);
        const firstModel = nextProvider?.models[0] ?? '';
        const firstEffort = nextProvider?.efforts.includes('high') ? 'high' : nextProvider?.efforts[0] ?? '';
        setEffort(firstEffort);
        if (firstModel) void handleUseModel(p, firstModel, { closePopup: false, requireActiveSession: false });
    };
    const workbench = (
        <CodeWorkbench
            activePopup={activePopup}
            activeSessionId={activeSessionId}
            availableCommands={availableCommands}
            codeWorkingDir={codeWorkingDir}
            currentEffortOptions={currentEffortOptions}
            currentModelOptions={currentModelOptions}
            disabled={sending}
            effort={effort}
            gitInfo={gitInfo}
            childRecovery={childRecovery}
            transportState={transportState}
            inputText={inputText}
            messages={messages}
            model={model}
            modelAssignments={modelAssignments}
            modelOptions={modelOptions}
            modelPresets={modelPresets}
            permissionMode={permissionMode}
            permissions={permissions}
            planEntries={planEntries}
            error={popupError}
            provider={provider}
            providerOptions={providerOptions}
            sending={sending}
            sessionTitle={sessionTitle}
            showCommands={showCommands}
            transcriptRef={transcriptRef}
            usage={usage}
            onClearModelAssignment={handleClearModelAssignment}
            onClosePopup={() => { setPopupError(''); setActivePopup(null); }}
            onCommandSelect={handleCommandSelect}
            onEffortChange={e => {
                setEffort(e);
                if (activeSessionId) void client.setSessionConfig(activeSessionId, 'thinking', e);
            }}
            onFooterProviderChange={handleFooterProviderChange}
            onInputChange={handleInputChange}
            onModelChange={m => { void handleUseModel(provider, m, { closePopup: false, requireActiveSession: false }); }}
            onPermissionAnswer={handlePermissionAnswer}
            onPermissionModeChange={setPermissionMode}
            onProviderChange={handleProviderChange}
            onRefreshProviders={() => { void refreshModelOptions(); }}
            onSetDefaultModel={handleSetDefaultModel}
            onSetModelAssignment={handleSetModelAssignment}
            onShowCommandsChange={setShowCommands}
            onSubmit={() => { void handleSubmit(); }}
            onUseModel={handleUseModel}
            onUseForNewSessions={(p, m) => {
                // slice 212: pre-session apply — updates provider/model -> selectedModelId
                // for the next createSession. handleUseModel returns before its own close
                // when there is no active session, so close the popup explicitly here.
                void handleUseModel(p, m, { requireActiveSession: false, closePopup: false });
                setActivePopup(null);
            }}
            onWorkingDirChange={handleWorkingDirChange}
            workspaceFrozen={workspaceFrozen}
            onPickWorkingDir={handlePickWorkspace}
        />
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
