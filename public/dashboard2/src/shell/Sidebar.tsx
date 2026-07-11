import { ChevronDown, ChevronRight, RefreshCw } from '@lucide/icons';
import { useCallback, useEffect, useState, type JSX } from 'react';
import type { DashboardInstance } from '../../../../src/manager/types.ts';
import {
    useManagerApi,
    type ChatSessionList,
} from '../providers/api-provider.tsx';
import { useAppScope } from '../state/scope.tsx';
import { Icon } from './Icon.tsx';

type SessionsCacheEntry =
    | { status: 'loading' }
    | { status: 'ready'; data: ChatSessionList }
    | { status: 'error'; message: string };

function instanceName(instance: DashboardInstance): string {
    const label = instance.label?.trim();
    if (label) return label;
    const workingDir = instance.workingDir?.replace(/[\\/]+$/, '');
    return workingDir?.split(/[\\/]/).pop() || `Instance ${instance.port}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Request failed';
}

export function Sidebar(): JSX.Element {
    const api = useManagerApi();
    const { selected, expandedPorts, selectSession, toggleInstance } = useAppScope();
    const [instances, setInstances] = useState<DashboardInstance[]>([]);
    const [instancesLoading, setInstancesLoading] = useState(true);
    const [instancesError, setInstancesError] = useState<string | null>(null);
    const [sessionsByPort, setSessionsByPort] = useState<Record<number, SessionsCacheEntry>>({});

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

    const handleInstanceClick = (instance: DashboardInstance): void => {
        if (instance.status !== 'online') return;
        const isExpanded = expandedPorts.includes(instance.port);
        toggleInstance(instance.port);
        if (!isExpanded && !sessionsByPort[instance.port]) {
            void loadSessions(instance.port);
        }
    };

    return (
        <aside className="d2-sidebar" aria-label="Instances and sessions">
            <header className="d2-sidebar-header">
                <div>
                    <strong>CLI-JAW</strong>
                    <span>Sessions</span>
                </div>
                <button
                    className="d2-icon-button"
                    type="button"
                    onClick={() => void loadInstances()}
                    disabled={instancesLoading}
                    aria-label="Refresh instances"
                    title="Refresh instances"
                >
                    <Icon icon={RefreshCw} />
                </button>
            </header>

            <div className="d2-tree" aria-live="polite">
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
                    return (
                        <div className="d2-instance-node" key={instance.port}>
                            <button
                                className="d2-instance-row"
                                type="button"
                                onClick={() => handleInstanceClick(instance)}
                                disabled={!isOnline}
                                aria-expanded={isOnline ? isExpanded : undefined}
                            >
                                <span className="d2-tree-chevron">
                                    {isOnline ? <Icon icon={isExpanded ? ChevronDown : ChevronRight} /> : null}
                                </span>
                                <span className="d2-instance-copy">
                                    <strong>{instanceName(instance)}</strong>
                                    <span>Port {instance.port}</span>
                                </span>
                                <span className={`d2-status d2-status-${instance.status}`}>{instance.status}</span>
                            </button>

                            {isExpanded ? (
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
            </div>
        </aside>
    );
}
