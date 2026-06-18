import { useCallback, useEffect, useState } from 'react';
import type { CodeSession, CodeSessionClient, StoredSession } from './code-session-client';

type CodeSessionListProps = {
    client: CodeSessionClient;
    activeSessionId: string | null;
    workingDir: string;
    onSelectSession: (sessionId: string) => void;
    onLoadSession: (sessionId: string, cwd: string) => void;
    onNewSession: () => void;
};

export function CodeSessionList({ client, activeSessionId, workingDir, onSelectSession, onLoadSession, onNewSession }: CodeSessionListProps) {
    const [sessions, setSessions] = useState<CodeSession[]>([]);
    const [storedSessions, setStoredSessions] = useState<StoredSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const [live, stored] = await Promise.all([
                client.listSessions(),
                client.listStoredSessions(workingDir || undefined).catch(() => []),
            ]);
            setSessions(live.filter(s => s.status !== 'closed'));
            const liveIds = new Set(live.map(s => s.sessionId));
            setStoredSessions(stored.filter(s => !liveIds.has(s.sessionId)));
        } catch {
            setSessions([]);
            setStoredSessions([]);
        } finally {
            setLoading(false);
        }
    }, [client, workingDir]);

    useEffect(() => { void refresh(); }, [refresh]);

    const cwdLabel = (cwd: string) => cwd.split('/').pop() || cwd;
    const liveSessionTitle = (session: CodeSession) => session.title?.trim()
        || session.sessionId.slice(0, 12)
        || 'Untitled session';
    const liveSessionMeta = (session: CodeSession) => cwdLabel(session.cwd);
    const liveSessionSearchText = (session: CodeSession) => [
        session.sessionId,
        session.title ?? '',
        session.cwd,
    ].join(' ').toLowerCase();
    const storedSessionTitle = (session: StoredSession) => session.title?.trim()
        || session.firstMessage?.replace(/\s+/g, ' ').trim()
        || session.sessionId.slice(0, 12)
        || 'Untitled session';
    const storedSessionTime = (session: StoredSession) => {
        if (typeof session.lastModified === 'number') return session.lastModified;
        if (session.updatedAt) {
            const parsed = Date.parse(session.updatedAt);
            if (Number.isFinite(parsed)) return parsed;
        }
        return 0;
    };
    const storedSessionMeta = (session: StoredSession) => {
        const parts = [cwdLabel(session.cwd)];
        if (session.messageCount !== undefined) parts.push(`${session.messageCount} messages`);
        return parts.filter(Boolean).join(' · ');
    };
    const storedSessionSearchText = (session: StoredSession) => [
        session.sessionId,
        session.title ?? '',
        session.firstMessage ?? '',
        session.cwd,
    ].join(' ').toLowerCase();
    const visibleStoredSessions = storedSessions
        .filter(s => !search || storedSessionSearchText(s).includes(search.toLowerCase()))
        .sort((left, right) => storedSessionTime(right) - storedSessionTime(left))
        .slice(0, 20);

    return (
        <div className="code-session-list">
            <div className="code-session-list-header">
                <span className="code-session-list-title">Sessions</span>
                <button type="button" className="code-session-new-btn" onClick={onNewSession} aria-label="New code session">+</button>
            </div>
            {(sessions.length + storedSessions.length) > 3 && (
                <input
                    className="code-session-search"
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search sessions..."
                />
            )}
            {loading ? (
                <div className="code-session-list-loading">Loading...</div>
            ) : (
                <>
                    {sessions.length > 0 && (
                        <ul className="code-session-list-items">
                            {sessions.filter(s => !search || liveSessionSearchText(s).includes(search.toLowerCase())).map(s => (
                                <li key={s.sessionId}>
                                    <button type="button"
                                        className={`code-session-item ${s.sessionId === activeSessionId ? 'active' : ''}`}
                                        onClick={() => onSelectSession(s.sessionId)}>
                                        <span className="code-session-cwd">{liveSessionTitle(s)}</span>
                                        <span className="code-session-meta">{liveSessionMeta(s)}</span>
                                        <span className={`code-session-status code-session-status-${s.status}`}>{s.status}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {visibleStoredSessions.length > 0 && (
                        <>
                            <div className="code-session-list-divider">History</div>
                            <ul className="code-session-list-items">
                                {visibleStoredSessions.map(s => (
                                    <li key={s.sessionId}>
                                        <button type="button" className="code-session-item"
                                            onClick={() => onLoadSession(s.sessionId, s.cwd)}>
                                            <span className="code-session-cwd">{storedSessionTitle(s)}</span>
                                            <span className="code-session-meta">{storedSessionMeta(s)}</span>
                                            <span className="code-session-status">stored</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {sessions.length === 0 && visibleStoredSessions.length === 0 && (
                        <div className="code-session-list-empty">No sessions. Type a prompt to start.</div>
                    )}
                </>
            )}
        </div>
    );
}
