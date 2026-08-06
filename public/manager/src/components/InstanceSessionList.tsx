import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';

// Inline session disclosure under the Active instance row (devlog
// 260806_manager_active_session_disclosure). Lazy: fetches only while open.
// Fields other than id/seq/label/message_count are absent when the instance
// runs with multiSession off, so everything renders with fallbacks.
export type ChatSessionSummary = {
    id: string;
    seq: number;
    label: string | null;
    remoteKey?: string | null;
    source?: string;
    message_count: number;
    lastActivityAt?: string | null;
};

type SessionsPayload = { sessions?: ChatSessionSummary[]; active?: string };

export async function fetchChatSessions(port: number): Promise<{ sessions: ChatSessionSummary[]; activeId: string | null }> {
    const res = await fetch(`/i/${port}/api/chat-sessions`);
    if (!res.ok) throw new Error(`sessions fetch failed: ${res.status}`);
    const body = await res.json() as { ok?: boolean; data?: SessionsPayload };
    const data = body.data || {};
    return {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        // `active` is always the active session ID string ('default' fallback);
        // per-row highlight is computed as session.id === activeId.
        activeId: typeof data.active === 'string' ? data.active : null,
    };
}

export async function switchChatSession(port: number, seq: number): Promise<void> {
    const res = await fetch(`/i/${port}/api/chat-sessions/${seq}/switch`, { method: 'POST' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `switch failed: ${res.status}`);
    }
}

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
    const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [switching, setSwitching] = useState<number | null>(null);

    useEffect(() => {
        if (!props.open) return;
        let cancelled = false;
        fetchChatSessions(props.port)
            .then(result => {
                if (cancelled) return;
                setSessions(result.sessions);
                setActiveId(result.activeId);
                setError(null);
            })
            .catch(err => { if (!cancelled) setError((err as Error).message); });
        return () => { cancelled = true; };
    }, [props.open, props.port]);

    if (!props.open) return null;

    async function handleSwitch(event: MouseEvent, session: ChatSessionSummary): Promise<void> {
        event.stopPropagation();
        if (session.id === activeId || switching != null) return;
        setSwitching(session.seq);
        setError(null);
        try {
            await switchChatSession(props.port, session.seq);
            const result = await fetchChatSessions(props.port);
            setSessions(result.sessions);
            setActiveId(result.activeId);
            props.onSessionSwitched?.();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSwitching(null);
        }
    }

    return (
        <div className="instance-session-list" role="list" aria-label="Chat sessions">
            {error && <div className="instance-session-error">{error}</div>}
            {sessions.map(session => {
                const isActive = session.id === activeId;
                const when = relativeTime(session.lastActivityAt);
                return (
                    <button
                        key={session.id}
                        type="button"
                        role="listitem"
                        className={`instance-session-row${isActive ? ' is-active' : ''}`}
                        disabled={switching != null}
                        aria-current={isActive || undefined}
                        onClick={(event) => void handleSwitch(event, session)}
                    >
                        <span className="instance-session-title">
                            {sessionTitle(session)}
                            {session.source && <span className="session-source-badge">{session.source}</span>}
                        </span>
                        <span className="instance-session-meta">
                            {switching === session.seq
                                ? 'switching…'
                                : `${session.message_count} msg${when ? ` · ${when}` : ''}`}
                        </span>
                    </button>
                );
            })}
            {sessions.length === 0 && !error && <div className="instance-session-empty">Loading sessions…</div>}
        </div>
    );
}
