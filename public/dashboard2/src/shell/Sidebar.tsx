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
import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
    DashboardInstance,
    DashboardLifecycleAction,
    DashboardLifecycleResult,
} from '../../../../src/manager/types.ts';
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
    const { selected, expandedPorts, selectSession, toggleInstance } = useAppScope();
    const [mode, setMode] = useState<SidebarMode>('jaw');
    const [instances, setInstances] = useState<DashboardInstance[]>([]);
    const [instancesLoading, setInstancesLoading] = useState(true);
    const [instancesError, setInstancesError] = useState<string | null>(null);
    const [sessionsByPort, setSessionsByPort] = useState<Record<number, SessionsCacheEntry>>({});
    const [menuPort, setMenuPort] = useState<number | null>(null);
    const [lifecycleBusyPort, setLifecycleBusyPort] = useState<number | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const openSettings = useCallback(() => setSettingsOpen(true), []);
    const closeSettings = useCallback(() => setSettingsOpen(false), []);

    const loadInstances = useCallback(async () => {
        setInstancesLoading(true);
        setInstancesError(null);
        try {
            setInstances(await api.fetchInstances());
        } catch (error) {
            setInstancesError(errorMessage(error));
        } finally {
            setInstancesLoading(false);
        }
    }, [api]);

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
    }, [loadInstances]);

    useEffect(() => {
        if (menuPort === null) return;
        const closeMenu = (event: PointerEvent): void => {
            const target = event.target;
            if (target instanceof Element && target.closest('[data-sidebar-instance-menu]')) return;
            setMenuPort(null);
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setMenuPort(null);
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

        setLifecycleBusyPort(instance.port);
        setInstancesError(null);
        setMenuPort(null);
        try {
            const response = await fetch(`/api/dashboard/lifecycle/${action}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ port: instance.port }),
            });
            const result = await response.json().catch(() => ({})) as Partial<DashboardLifecycleResult>;
            if (!response.ok || result.ok !== true) {
                throw new Error(result.message || `${action} failed (${response.status})`);
            }
            await loadInstances();
        } catch (error) {
            setInstancesError(errorMessage(error));
        } finally {
            setLifecycleBusyPort(null);
        }
    };

    const activeInstanceCount = instances.filter((instance) => instanceVisualStatus(instance) !== 'off').length;

    return (
        <>
            <aside className="d2-sidebar d2-sidebar-v4" aria-label="Instances and sessions">
            <div className="d2-sidebar-topbar">
                <button
                    className="d2-sidebar-toggle"
                    type="button"
                    onClick={onClose}
                    disabled={!onClose}
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
                        type="button"
                        role="tab"
                        aria-selected={mode === 'jaw'}
                        onClick={() => setMode('jaw')}
                    >
                        <Icon icon={Terminal} />
                        <span>jaw</span>
                        <span className="d2-mode-badge">{activeInstanceCount}</span>
                    </button>
                    <button
                        className={`d2-mode-button${mode === 'jwc' ? ' is-active' : ''}`}
                        type="button"
                        role="tab"
                        aria-selected={mode === 'jwc'}
                        onClick={() => setMode('jwc')}
                    >
                        <Icon icon={MessageSquare} />
                        <span>jwc</span>
                    </button>
                </div>
            </div>

            <div className="d2-sidebar-list" aria-live="polite">
                {mode === 'jwc' ? (
                    <div className="d2-sidebar-empty">No jwc conversations</div>
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
                            const lifecycleBusy = lifecycleBusyPort === instance.port;
                            const sessionEntry = sessionsByPort[instance.port];
                            const isSingleSession = sessionEntry?.status === 'ready' && sessionEntry.data.sessions.length === 1;
                            const showExpanded = isExpanded && !isSingleSession;
                            return (
                                <div className="d2-instance-node" key={instance.port}>
                                    <div className={`d2-instance-row${selected?.port === instance.port ? ' is-selected' : ''}`}>
                                        <button
                                            className="d2-instance-main"
                                            type="button"
                                            onClick={() => handleInstanceClick(instance)}
                                            disabled={!isOnline}
                                            aria-expanded={isOnline ? isExpanded : undefined}
                                        >
                                            <span className={`d2-instance-dot is-${visualStatus}`} />
                                            <span className="d2-instance-copy">
                                                <strong>{instanceName(instance)}</strong>
                                                <span><span className="d2-instance-port">:{instance.port}</span> &middot; {instance.status}</span>
                                            </span>
                                            <span className="d2-tree-chevron">
                                                {isOnline && !isSingleSession ? <Icon icon={isExpanded ? ChevronDown : ChevronRight} /> : null}
                                            </span>
                                        </button>

                                        <div className="d2-instance-trail" data-sidebar-instance-menu>
                                            {visualStatus === 'busy' || lifecycleBusy ? <span className="d2-instance-spinner" /> : null}
                                            <button
                                                className={`d2-instance-control is-${isOnline ? 'stop' : 'start'}`}
                                                type="button"
                                                disabled={!lifecycleAllowed || lifecycleBusy}
                                                onClick={() => void runLifecycleAction(lifecycleAction, instance)}
                                                title={lifecycleAllowed ? `${isOnline ? 'Stop' : 'Start'} :${instance.port}` : lifecycle?.reason || `${isOnline ? 'Stop' : 'Start'} unavailable`}
                                                aria-label={`${isOnline ? 'Stop' : 'Start'} ${instanceName(instance)}`}
                                            >
                                                <Icon icon={isOnline ? Square : Play} />
                                            </button>
                                            <button
                                                className="d2-instance-more"
                                                type="button"
                                                onClick={() => setMenuPort(isMenuOpen ? null : instance.port)}
                                                aria-haspopup="menu"
                                                aria-expanded={isMenuOpen}
                                                aria-label={`More actions for ${instanceName(instance)}`}
                                                title="More"
                                            >
                                                <Icon icon={Ellipsis} />
                                            </button>
                                            {isMenuOpen ? (
                                                <div className="d2-instance-menu" role="menu">
                                                    <button type="button" role="menuitem" disabled title="Rename API unavailable">Rename</button>
                                                    <button type="button" role="menuitem" disabled={!lifecycle?.canRestart || lifecycleBusy} onClick={() => void runLifecycleAction('restart', instance)}>Restart</button>
                                                    <button type="button" role="menuitem" disabled={!lifecycle?.canPerm || lifecycleBusy} onClick={() => void runLifecycleAction('perm', instance)}>Set as permanent</button>
                                                    <button type="button" role="menuitem" disabled={!projectDir} onClick={() => void copyPath(projectDir)}>Copy project dir</button>
                                                    <button type="button" role="menuitem" disabled={!instance.workingDir} onClick={() => void copyPath(instance.workingDir)}>Copy working dir</button>
                                                    <button type="button" role="menuitem" disabled title="Terminal bridge unavailable">Open in terminal</button>
                                                    <button className="is-danger" type="button" role="menuitem" disabled={!lifecycle?.canStop || lifecycleBusy} onClick={() => void runLifecycleAction('stop', instance)}>Stop</button>
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>

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
