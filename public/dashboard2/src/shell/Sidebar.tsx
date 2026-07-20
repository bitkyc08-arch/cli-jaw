import {
    ChevronDown,
    ChevronRight,
    Ellipsis,
    MessageSquare,
    MonitorCog,
    Moon,
    PanelLeftClose,
    Play,
    Settings,
    Square,
    Sun,
    Terminal,
} from '@lucide/icons';
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
} from '../../../../src/manager/types.ts';
import { useInstanceLifecycle } from '../lifecycle/use-instance-lifecycle.ts';
import {
    useManagerApi,
    type ChatSessionList,
} from '../providers/api-provider.tsx';
import { usePreferences } from '../providers/preferences-provider.tsx';
import { useAppScope } from '../state/scope.tsx';
import { Icon } from './Icon.tsx';
import { SettingsModal } from './SettingsModal.tsx';

type SessionsCacheEntry =
    | { status: 'loading' }
    | { status: 'ready'; data: ChatSessionList }
    | { status: 'error'; message: string };

type SidebarMode = 'jaw' | 'jwc';
type InstanceVisualStatus = 'running' | 'off' | 'busy';

// 062 — lightweight jwc sidebar types. These mirror code-history-adapter's
// CodeHistorySummary but are defined inline to avoid importing code/ modules
// (lazy boundary). The sidebar uses raw fetch against the same REST endpoints.
interface JwcConversation {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt?: string;
}

type JwcCapabilityReason = 'ok' | 'missing_binary' | 'acp_unsupported' | 'temporarily_unavailable';

interface JwcSidebarState {
    capability: JwcCapabilityReason | 'loading' | 'error';
    conversations: JwcConversation[];
    loading: boolean;
}

const JWC_CAPABILITY_REASONS = new Set<JwcCapabilityReason>(['ok', 'missing_binary', 'acp_unsupported', 'temporarily_unavailable']);

async function fetchJwcCapability(port: number): Promise<JwcCapabilityReason> {
    try {
        const res = await fetch(`/i/${port}/api/code/capabilities`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return 'temporarily_unavailable';
        const body = await res.json() as Record<string, unknown>;
        const reason = body['reason'] as JwcCapabilityReason;
        return JWC_CAPABILITY_REASONS.has(reason) ? reason : 'temporarily_unavailable';
    } catch {
        return 'temporarily_unavailable';
    }
}

async function fetchJwcConversations(port: number): Promise<JwcConversation[]> {
    const res = await fetch(`/i/${port}/api/code/sessions/stored?scope=all`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const body = await res.json() as Record<string, unknown>;
    const sessions = Array.isArray(body['sessions']) ? body['sessions'] as Array<Record<string, unknown>> : [];
    return sessions
        .filter((s): s is Record<string, unknown> => typeof s['sessionId'] === 'string' && typeof s['cwd'] === 'string')
        .map(s => ({
            sessionId: String(s['sessionId']),
            title: String(s['title'] || s['firstMessage'] || String(s['sessionId']).slice(0, 8)),
            cwd: String(s['cwd']),
            ...(typeof s['updatedAt'] === 'string' ? { updatedAt: s['updatedAt'] } : {}),
        }));
}

export interface SidebarProps {
    onClose?: () => void;
}

function instanceName(instance: DashboardInstance): string {
    const label = instance.label?.trim();
    if (label) return label;
    const workingDir = instance.workingDir?.replace(/[\\/]+$/, '');
    return workingDir?.split(/[\\/]/).pop() || `Instance ${instance.port}`;
}

function instanceVisualStatus(instance: DashboardInstance): InstanceVisualStatus {
    const status = String(instance.status);
    if (status === 'busy' || status === 'working') return 'busy';
    return status === 'online' ? 'running' : 'off';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Request failed';
}

const THEME_CYCLE = ['auto', 'dark', 'light'] as const;

function ThemeToggle(): JSX.Element {
    const { theme } = usePreferences();
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme.mode as typeof THEME_CYCLE[number]) + 1) % THEME_CYCLE.length]!;
    const icon = theme.mode === 'auto' ? MonitorCog : theme.mode === 'dark' ? Moon : Sun;
    return (
        <button
            className="d2-icon-button d2-sidebar-theme"
            type="button"
            onClick={() => theme.setMode(next)}
            aria-label={`Theme: ${theme.mode} (switch to ${next})`}
            title={`Theme: ${theme.mode} (switch to ${next})`}
        >
            <Icon icon={icon} />
        </button>
    );
}

export function Sidebar({ onClose }: SidebarProps): JSX.Element {
    const api = useManagerApi();
    const { selected, expandedPorts, selectSession, toggleInstance, openSidePane, openPanel } = useAppScope();
    const [mode, setMode] = useState<SidebarMode>('jaw');
    const [instances, setInstances] = useState<DashboardInstance[]>([]);
    const [instancesLoading, setInstancesLoading] = useState(true);
    const [instancesError, setInstancesError] = useState<string | null>(null);
    const [sessionsByPort, setSessionsByPort] = useState<Record<number, SessionsCacheEntry>>({});
    const [menuPort, setMenuPort] = useState<number | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    // 062 — jwc sidebar state (raw fetch, no code/ import)
    const [jwcState, setJwcState] = useState<JwcSidebarState>({
        capability: 'loading',
        conversations: [],
        loading: true,
    });
    const [jwcRefresh, setJwcRefresh] = useState(0);
    const instancesRequestRef = useRef<{ generation: number; controller: AbortController | null }>({
        generation: 0,
        controller: null,
    });
    const menuTriggerRef = useRef<HTMLElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([null, null]);
    const openSettings = useCallback(() => setSettingsOpen(true), []);
    const closeSettings = useCallback(() => setSettingsOpen(false), []);

    const patchInstance = useCallback((next: DashboardInstance) => {
        const activeRequest = instancesRequestRef.current;
        activeRequest.controller?.abort();
        instancesRequestRef.current = {
            generation: activeRequest.generation + 1,
            controller: null,
        };
        setInstances(current => current.map(instance => (
            instance.port === next.port ? next : instance
        )));
        setInstancesLoading(false);
    }, []);

    const loadInstances = useCallback(async () => {
        const previous = instancesRequestRef.current;
        previous.controller?.abort();
        const generation = previous.generation + 1;
        const controller = new AbortController();
        instancesRequestRef.current = { generation, controller };
        setInstancesLoading(true);
        setInstancesError(null);
        try {
            const next = await api.fetchInstances({ signal: controller.signal });
            if (instancesRequestRef.current.generation !== generation || controller.signal.aborted) return;
            setInstances(next);
        } catch (error) {
            if (instancesRequestRef.current.generation !== generation || controller.signal.aborted) return;
            setInstancesError(errorMessage(error));
        } finally {
            if (instancesRequestRef.current.generation === generation) {
                instancesRequestRef.current = { generation, controller: null };
                setInstancesLoading(false);
            }
        }
    }, [api]);

    const lifecycleControl = useInstanceLifecycle({
        patchInstance,
        refreshInstances: loadInstances,
    });

    const loadSessions = useCallback(async (port: number) => {
        setSessionsByPort((cache) => ({ ...cache, [port]: { status: 'loading' } }));
        try {
            const data = await api.fetchSessions(port);
            setSessionsByPort((cache) => ({ ...cache, [port]: { status: 'ready', data } }));
        } catch (error) {
            setSessionsByPort((cache) => ({
                ...cache,
                [port]: { status: 'error', message: errorMessage(error) },
            }));
        }
    }, [api]);

    useEffect(() => {
        void loadInstances();
        return () => {
            const activeRequest = instancesRequestRef.current;
            activeRequest.controller?.abort();
            instancesRequestRef.current = {
                generation: activeRequest.generation + 1,
                controller: null,
            };
        };
    }, [loadInstances]);

    // 062 — fetch jwc capability + stored sessions when jwc mode is active.
    // Uses the first online instance port (or selected port) since Code
    // sessions are served by the per-instance ACP host.
    useEffect(() => {
        if (mode !== 'jwc') return;
        const port = selected?.port ?? instances.find(i => i.status === 'online')?.port;
        if (!port) {
            setJwcState({ capability: 'temporarily_unavailable', conversations: [], loading: false });
            return;
        }
        let mounted = true;
        setJwcState(prev => ({ ...prev, loading: true }));
        void (async () => {
            const capability = await fetchJwcCapability(port);
            if (!mounted) return;
            if (capability !== 'ok') {
                setJwcState({ capability, conversations: [], loading: false });
                return;
            }
            const conversations = await fetchJwcConversations(port);
            if (!mounted) return;
            setJwcState({ capability: 'ok', conversations, loading: false });
        })();
        return () => { mounted = false; };
    }, [mode, selected?.port, instances, jwcRefresh]);

    useEffect(() => {
        if (menuPort === null) return;
        // Auto-focus first menuitem on open
        requestAnimationFrame(() => {
            const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
            firstItem?.focus();
        });
        const closeMenu = (event: PointerEvent): void => {
            const target = event.target;
            if (target instanceof Element && target.closest('[data-sidebar-instance-menu]')) return;
            setMenuPort(null);
            menuTriggerRef.current?.focus();
            menuTriggerRef.current = null;
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setMenuPort(null);
                menuTriggerRef.current?.focus();
                menuTriggerRef.current = null;
            }
        };
        document.addEventListener('pointerdown', closeMenu);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeMenu);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [menuPort]);

    const handleInstanceClick = (instance: DashboardInstance): void => {
        if (instance.status !== 'online') return;
        const isExpanded = expandedPorts.includes(instance.port);
        toggleInstance(instance.port);
        if (!isExpanded && !sessionsByPort[instance.port]) {
            void loadSessions(instance.port);
        }
    };

    // Single-session auto-select: when sessions load and there's exactly one,
    // select it automatically without showing the expanded list.
    useEffect(() => {
        // Only auto-select if nothing is currently selected, to avoid oscillation
        // when multiple instances each have exactly one session.
        if (selected) return;
        for (const [portStr, entry] of Object.entries(sessionsByPort)) {
            if (entry.status !== 'ready') continue;
            const port = Number(portStr);
            if (entry.data.sessions.length === 1) {
                const session = entry.data.sessions[0]!;
                selectSession(port, session.id);
                return; // select the first match only
            }
        }
    }, [sessionsByPort, selected, selectSession]); // eslint-disable-line react-hooks/exhaustive-deps

    const copyPath = async (path: string | null | undefined): Promise<void> => {
        if (!path) return;
        try {
            await navigator.clipboard.writeText(path);
            setMenuPort(null);
        } catch {
            // Keep the menu open so the user can retry after clipboard permission changes.
        }
    };

    const runLifecycleAction = async (
        action: DashboardLifecycleAction,
        instance: DashboardInstance,
    ): Promise<void> => {
        const lifecycle = instance.lifecycle;
        if (!lifecycle) return;
        if (action === 'perm' && !window.confirm(`Register :${instance.port} as a persistent system service?`)) return;
        if (action === 'stop' && lifecycle.owner === 'service') {
            if (!window.confirm(`Stop :${instance.port}? This will also remove the persistent service.`)) return;
        } else if ((action === 'stop' || action === 'restart') && !window.confirm(`${action} :${instance.port}?`)) {
            return;
        }

        setInstancesError(null);
        setMenuPort(null);
        await lifecycleControl.run(action, instance);
    };

    const activeInstanceCount = instances.filter((instance) => instanceVisualStatus(instance) !== 'off').length;

    // Roving tabindex helpers for the mode switcher tablist
    const SIDEBAR_MODES: SidebarMode[] = ['jaw', 'jwc'];
    const activeTabId = `d2-sidebar-tab-${mode}`;

    const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        const currentIndex = SIDEBAR_MODES.indexOf(mode);
        let nextIndex: number | null = null;
        switch (event.key) {
            case 'ArrowRight':
                nextIndex = (currentIndex + 1) % SIDEBAR_MODES.length;
                break;
            case 'ArrowLeft':
                nextIndex = (currentIndex - 1 + SIDEBAR_MODES.length) % SIDEBAR_MODES.length;
                break;
            case 'Home':
                nextIndex = 0;
                break;
            case 'End':
                nextIndex = SIDEBAR_MODES.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        const nextMode = SIDEBAR_MODES[nextIndex]!;
        setMode(nextMode);
        tabRefs.current[nextIndex]?.focus();
    };

    // Menu keyboard navigation (Up/Down between menuitems)
    const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
        items[next]?.focus();
    };

    return (
        <>
            <aside className="d2-sidebar d2-sidebar-v4" aria-label="Instances and sessions">
            <div className="d2-sidebar-topbar">
                <button
                    className="d2-sidebar-toggle"
                    type="button"
                   onClick={onClose}
                   disabled={!onClose}
                    aria-expanded={true}
                    aria-label="Close sidebar"
                    title={onClose ? 'Close sidebar' : 'Close sidebar unavailable'}
                >
                    <Icon icon={PanelLeftClose} />
                </button>
            </div>

            <div className="d2-sidebar-top">
                <div className="d2-mode-switcher" role="tablist" aria-label="Sidebar mode">
                    <button
                        className={`d2-mode-button${mode === 'jaw' ? ' is-active' : ''}`}
                        ref={(el) => { tabRefs.current[0] = el; }}
                        id="d2-sidebar-tab-jaw"
                        type="button"
                        role="tab"
                        aria-selected={mode === 'jaw'}
                        aria-controls="d2-sidebar-panel"
                        tabIndex={mode === 'jaw' ? 0 : -1}
                        onKeyDown={handleTabKeyDown}
                        onClick={() => setMode('jaw')}
                    >
                        <Icon icon={Terminal} />
                        <span>jaw</span>
                        <span className="d2-mode-badge">{activeInstanceCount}</span>
                    </button>
                    <button
                        className={`d2-mode-button${mode === 'jwc' ? ' is-active' : ''}`}
                        ref={(el) => { tabRefs.current[1] = el; }}
                        id="d2-sidebar-tab-jwc"
                        type="button"
                        role="tab"
                        aria-selected={mode === 'jwc'}
                        aria-controls="d2-sidebar-panel"
                        tabIndex={mode === 'jwc' ? 0 : -1}
                        onKeyDown={handleTabKeyDown}
                        onClick={() => setMode('jwc')}
                    >
                        <Icon icon={MessageSquare} />
                        <span>jwc</span>
                    </button>
                </div>
            </div>

            <div className="d2-sidebar-list" role="tabpanel" id="d2-sidebar-panel" aria-labelledby={activeTabId} aria-live="polite">
               {mode === 'jwc' ? (
                    jwcState.loading ? (
                        <div className="d2-inline-state"><span className="d2-spinner" aria-hidden="true" />Loading Code sessions</div>
                    ) : jwcState.capability === 'missing_binary' ? (
                        <div className="d2-sidebar-empty" data-jwc-state="missing_binary">
                            <strong>jwc is not installed</strong>
                            <span>Install the JWC runtime to use Code sessions.</span>
                        </div>
                    ) : jwcState.capability === 'acp_unsupported' ? (
                        <div className="d2-sidebar-empty" data-jwc-state="acp_unsupported">
                            <strong>jwc version not supported</strong>
                            <span>Update jwc to a build that supports ACP mode.</span>
                        </div>
                    ) : jwcState.capability === 'temporarily_unavailable' ? (
                        <div className="d2-sidebar-empty" data-jwc-state="temporarily_unavailable">
                            <span>Code runtime temporarily unavailable</span>
                            <button type="button" className="d2-sidebar-retry" onClick={() => setJwcRefresh(n => n + 1)}>
                                Retry
                            </button>
                        </div>
                    ) : jwcState.capability === 'error' ? (
                        <div className="d2-sidebar-empty" data-jwc-state="error">
                            <span>Failed to check Code availability</span>
                            <button type="button" className="d2-sidebar-retry" onClick={() => setJwcRefresh(n => n + 1)}>
                                Retry
                            </button>
                        </div>
                    ) : jwcState.conversations.length === 0 ? (
                        <div className="d2-sidebar-empty">No jwc conversations</div>
                    ) : (
                        jwcState.conversations.map(conv => (
                            <button
                                key={conv.sessionId}
                                className="d2-instance-row d2-jwc-conv-row"
                                type="button"
                                onClick={() => openSidePane()}
                                title={conv.title}
                            >
                                <div className="d2-instance-main">
                                    <span className="d2-instance-dot is-off" aria-hidden="true" />
                                    <div className="d2-instance-copy">
                                        <strong>{conv.title}</strong>
                                        <span>{conv.cwd}</span>
                                    </div>
                                </div>
                            </button>
                        ))
                    )
                ) : (
                    <>
                        {instancesLoading && instances.length === 0 ? (
                            <div className="d2-inline-state"><span className="d2-spinner" />Loading instances</div>
                        ) : null}
                        {instancesError ? (
                            <div className="d2-error-block">
                                <span>{instancesError}</span>
                                <button type="button" onClick={() => void loadInstances()}>Retry</button>
                            </div>
                        ) : null}
                        {!instancesLoading && !instancesError && instances.length === 0 ? (
                            <div className="d2-inline-state">No instances found</div>
                        ) : null}

                        {instances.map((instance) => {
                            const isOnline = instance.status === 'online';
                            const isExpanded = isOnline && expandedPorts.includes(instance.port);
                            const sessions = sessionsByPort[instance.port];
                            const visualStatus = instanceVisualStatus(instance);
                            const projectDir = instance.projectDirs?.[0];
                            const isMenuOpen = menuPort === instance.port;
                            const lifecycle = instance.lifecycle;
                            const lifecycleAction: DashboardLifecycleAction = isOnline ? 'stop' : 'start';
                            const lifecycleAllowed = isOnline ? lifecycle?.canStop === true : lifecycle?.canStart === true;
                            const lifecycleBusy = lifecycleControl.busyPort === instance.port && lifecycleControl.busy;
                            const lifecycleError = lifecycleControl.ui.port === instance.port && lifecycleControl.ui.phase === 'error'
                                ? lifecycleControl.ui.message
                                : null;
                            const lifecycleBlocked = lifecycleControl.busy;
                            const sessionEntry = sessionsByPort[instance.port];
                            const isSingleSession = sessionEntry?.status === 'ready' && sessionEntry.data.sessions.length === 1;
                            const showExpanded = isExpanded && !isSingleSession;
                            return (
                                <div className="d2-instance-node" key={instance.port}>
                                    <div
                                        className={`d2-instance-row${selected?.port === instance.port ? ' is-selected' : ''}`}
                                        aria-busy={lifecycleBusy || undefined}
                                    >
                                        <button
                                            className="d2-instance-main"
                                            type="button"
                                            onClick={() => handleInstanceClick(instance)}
                                            disabled={!isOnline}
                                            aria-expanded={isOnline ? isExpanded : undefined}
                                        >
                                            <span className={`d2-instance-dot is-${visualStatus}`} aria-hidden="true" />
                                            <span className="d2-instance-copy">
                                                <strong>{instanceName(instance)}</strong>
                                                <span><span className="d2-instance-port">:{instance.port}</span> &middot; {instance.status}</span>
                                            </span>
                                            <span className="d2-tree-chevron">
                                                {isOnline && !isSingleSession ? <Icon icon={isExpanded ? ChevronDown : ChevronRight} /> : null}
                                            </span>
                                        </button>

                                        <div className="d2-instance-trail" data-sidebar-instance-menu>
                                            {visualStatus === 'busy' || lifecycleBusy ? <span className="d2-instance-spinner" aria-hidden="true" /> : null}
                                            <button
                                                className={`d2-instance-control is-${isOnline ? 'stop' : 'start'} is-always-visible`}
                                                type="button"
                                                disabled={!lifecycleAllowed || lifecycleBlocked}
                                                onClick={() => void runLifecycleAction(lifecycleAction, instance)}
                                                title={lifecycleAllowed ? `${lifecycleError ? 'Retry' : isOnline ? 'Stop' : 'Start'} :${instance.port}` : lifecycle?.reason || `${isOnline ? 'Stop' : 'Start'} unavailable`}
                                                aria-label={`${lifecycleError ? 'Retry' : isOnline ? 'Stop' : 'Start'} ${instanceName(instance)}`}
                                            >
                                                <Icon icon={isOnline ? Square : Play} />
                                            </button>
                                            <button
                                                className="d2-instance-more"
                                                type="button"
                                               disabled={lifecycleBlocked}
                                                onClick={() => {
                                                    if (isMenuOpen) {
                                                        setMenuPort(null);
                                                    } else {
                                                        menuTriggerRef.current = document.activeElement as HTMLElement;
                                                        setMenuPort(instance.port);
                                                    }
                                                }}
                                                aria-haspopup="menu"
                                                aria-expanded={isMenuOpen}
                                                aria-label={`More actions for ${instanceName(instance)}`}
                                                title="More"
                                            >
                                                <Icon icon={Ellipsis} />
                                            </button>
                                            {isMenuOpen ? (
                                                <div className="d2-instance-menu" role="menu" ref={menuRef} onKeyDown={handleMenuKeyDown}>
                                                    <button type="button" role="menuitem" disabled title="Rename API unavailable">Rename</button>
                                                    <button type="button" role="menuitem" disabled={!lifecycle?.canRestart || lifecycleBlocked} onClick={() => void runLifecycleAction('restart', instance)}>Restart</button>
                                                    <button type="button" role="menuitem" disabled={!lifecycle?.canPerm || lifecycleBlocked} onClick={() => void runLifecycleAction('perm', instance)}>Set as permanent</button>
                                                    <button type="button" role="menuitem" disabled={!projectDir} onClick={() => void copyPath(projectDir)}>Copy project dir</button>
                                                    <button type="button" role="menuitem" disabled={!instance.workingDir} onClick={() => void copyPath(instance.workingDir)}>Copy working dir</button>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        disabled={!isOnline || selected?.port !== instance.port}
                                                        title={!isOnline ? 'Instance is offline' : selected?.port !== instance.port ? 'Select this instance to open a terminal' : 'Open in terminal'}
                                                        onClick={() => {
                                                            setMenuPort(null);
                                                            openSidePane();
                                                            openPanel({ type: 'terminal', key: 'terminal', title: 'Terminal', keepAlive: true });
                                                        }}
                                                    >Open in terminal</button>
                                                    <button className="is-danger" type="button" role="menuitem" disabled={!lifecycle?.canStop || lifecycleBlocked} onClick={() => void runLifecycleAction('stop', instance)}>Stop</button>
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>

                                    {lifecycleBusy ? (
                                        <div className="d2-instance-lifecycle-message" role="status">
                                            {lifecycleControl.ui.message || `${lifecycleAction === 'start' ? 'Starting' : 'Stopping'}…`}
                                        </div>
                                    ) : null}
                                    {lifecycleError ? (
                                        <div className="d2-instance-lifecycle-message is-error" role="alert">
                                            {lifecycleError}
                                        </div>
                                    ) : null}

                                    {showExpanded ? (
                                        <div className="d2-session-list">
                                            {!sessions || sessions.status === 'loading' ? (
                                                <div className="d2-inline-state"><span className="d2-spinner" />Loading sessions</div>
                                            ) : null}
                                            {sessions?.status === 'error' ? (
                                                <div className="d2-session-error">
                                                    <span>{sessions.message}</span>
                                                    <button type="button" onClick={() => void loadSessions(instance.port)}>Retry</button>
                                                </div>
                                            ) : null}
                                            {sessions?.status === 'ready' && sessions.data.sessions.length === 0 ? (
                                                <div className="d2-inline-state">No sessions</div>
                                            ) : null}
                                            {sessions?.status === 'ready' ? sessions.data.sessions.map((session) => {
                                                const active = sessions.data.active === session.id;
                                                const selectedRow = selected?.port === instance.port && selected.sessionId === session.id;
                                                return (
                                                    <button
                                                        className={`d2-session-row${selectedRow ? ' is-selected' : ''}`}
                                                        type="button"
                                                        key={session.id}
                                                        onClick={() => selectSession(instance.port, session.id)}
                                                        aria-current={selectedRow ? 'page' : undefined}
                                                    >
                                                        <span className="d2-session-copy">
                                                            <span>{session.label?.trim() || `Session ${session.seq}`}</span>
                                                            <small>{session.message_count} messages</small>
                                                        </span>
                                                        {active ? <span className="d2-active-mark">Active</span> : null}
                                                    </button>
                                                );
                                            }) : null}
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </>
                )}
            </div>

            <footer className="d2-sidebar-footer d2-sidebar-footer-v4">
                <span className="d2-sidebar-brand">JAW</span>
                <button
                    className="d2-sidebar-settings"
                    type="button"
                    onClick={openSettings}
                    title="Settings"
                    aria-label="Settings"
                >
                    <Icon icon={Settings} />
                </button>
                <ThemeToggle />
            </footer>
            </aside>
            <SettingsModal isOpen={settingsOpen} onClose={closeSettings} />
        </>
    );
}
