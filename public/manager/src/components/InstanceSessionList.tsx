import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import {
    getSessionSnapshot,
    loadSessions,
    retrySessions,
    subscribeSessions,
    switchSession,
} from '../lib/session-store';
import type { ChatSessionSummary } from '../lib/session-store';

export type { ChatSessionSummary } from '../lib/session-store';

// Inline session disclosure under the Active instance row. Lazy: fetches only while open.
// Fields other than id/seq/label/message_count are absent when the instance
// runs with multiSession off, so everything renders with fallbacks.
/** "jaw:slack:channel:C0BM..:thread:1785.." → "slack C0BM.. · thread" */
function summarizeRemoteKey(remoteKey: string): string {
    const parts = remoteKey.split(':');
    if (parts.length >= 4 && parts[0] === 'jaw') {
        const channel = parts[3] || '';
        const threaded = parts.includes('thread');
        return `${parts[1]} ${channel.slice(0, 11)}${threaded ? ' · thread' : ''}`;
    }
    return remoteKey.slice(0, 32);
}

function sessionTitle(session: ChatSessionSummary): string {
    if (session.label && !session.label.startsWith('jaw:')) return session.label;
    if (session.remoteKey) return summarizeRemoteKey(session.remoteKey);
    if (session.label) return summarizeRemoteKey(session.label);
    return session.seq === 0 ? 'Default session' : `Session #${session.seq}`;
}

function relativeTime(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const then = new Date(iso.replace(' ', 'T')).getTime();
    if (Number.isNaN(then)) return null;
    const minutes = Math.floor((Date.now() - then) / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

type InstanceSessionListProps = {
    port: number;
    open: boolean;
    onSessionSwitched?: () => void;
};

export function InstanceSessionList(props: InstanceSessionListProps) {
    const subscribe = useCallback(
        (callback: () => void) => subscribeSessions(props.port, callback),
        [props.port],
    );
    const snapshot = useSyncExternalStore(subscribe, () => getSessionSnapshot(props.port));

    useEffect(() => {
        if (!props.open) return;
        void loadSessions(props.port).catch(() => { /* snapshot exposes the error */ });
    }, [props.open, props.port]);

    if (!props.open) return null;

    async function handleSwitch(event: MouseEvent, session: ChatSessionSummary): Promise<void> {
        event.stopPropagation();
        if (session.id === snapshot.data?.activeId || snapshot.switching) return;
        try {
            await switchSession(props.port, session.seq);
            props.onSessionSwitched?.();
        } catch { /* snapshot exposes the error */ }
    }

    const retry = (event: MouseEvent): void => {
        event.stopPropagation();
        void retrySessions(props.port).catch(() => { /* snapshot exposes the error */ });
    };

    if (snapshot.error?.kind === 'load') {
        return (
            <div className="instance-session-list" role="list" aria-label="Chat sessions">
                <div className="instance-session-error">
                    <span>{snapshot.error.message}</span>
                    <button type="button" className="instance-session-retry" onClick={retry}>Retry</button>
                </div>
            </div>
        );
    }

    if (snapshot.data === null) {
        return (
            <div className="instance-session-list" role="list" aria-label="Chat sessions">
                <div className="instance-session-empty">Loading sessions…</div>
            </div>
        );
    }

    const sessions = snapshot.data.sessions;
    if (sessions.length === 0) return null;
    const activeId = snapshot.data?.activeId ?? null;

    return (
        <div className="instance-session-list" role="list" aria-label="Chat sessions">
            {snapshot.error?.kind === 'switch' && (
                <div className="instance-session-error">
                    <span>{snapshot.error.message}</span>
                    <button type="button" className="instance-session-retry" onClick={retry}>Retry</button>
                </div>
            )}
            {sessions.map(session => {
                const isActive = session.id === activeId;
                const when = relativeTime(session.lastActivityAt);
                return (
                    <button
                        key={session.id}
                        type="button"
                        role="listitem"
                        className={`instance-session-row${isActive ? ' is-active' : ''}`}
                        disabled={snapshot.switching}
                        aria-current={isActive || undefined}
                        onClick={(event) => void handleSwitch(event, session)}
                    >
                        <span className="instance-session-title">
                            {sessionTitle(session)}
                            {session.source && <span className="session-source-badge">{session.source}</span>}
                        </span>
                        <span className="instance-session-meta">
                            {snapshot.switching
                                ? 'switching…'
                                : `${session.message_count} msg${when ? ` · ${when}` : ''}`}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
