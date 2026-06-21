import { useCallback, useEffect, useState } from 'react';
import type { CodeSession, CodeSessionClient, StoredSession } from './code-session-client';

type SessionViewMode = 'all' | 'cwd' | 'grouped';

type CodeSessionListProps = {
    client: CodeSessionClient;
    activeSessionId: string | null;
    workingDir: string;
    onSelectSession: (session: CodeSession) => void;
    onLoadSession: (sessionId: string, cwd: string) => void;
    onNewSession: () => void;
};

export function CodeSessionList({ client, activeSessionId, workingDir, onSelectSession, onLoadSession, onNewSession }: CodeSessionListProps) {
    const [sessions, setSessions] = useState<CodeSession[]>([]);
    const [storedSessions, setStoredSessions] = useState<StoredSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [search, setSearch] = useState('');
    const [viewMode, setViewMode] = useState<SessionViewMode>('all');

    const refresh = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);
        const storedOptions = viewMode === 'cwd'
            ? { scope: 'cwd' as const, cwd: workingDir }
            : { scope: 'all' as const };
        const [liveResult, storedResult] = await Promise.allSettled([
            client.listSessions(),
            client.listStoredSessions(storedOptions),
        ]);
        const errors: string[] = [];
        if (liveResult.status === 'fulfilled') {
            const live = liveResult.value;
            setSessions(live.filter(s => s.status !== 'closed'));
            const liveIds = new Set(live.map(s => s.sessionId));
            if (storedResult.status === 'fulfilled') {
                setStoredSessions(storedResult.value.filter(s => !liveIds.has(s.sessionId)));
            } else {
                setStoredSessions([]);
                errors.push(`History: ${errorText(storedResult.reason)}`);
            }
        } else {
            setSessions([]);
            errors.push(`Live: ${errorText(liveResult.reason)}`);
            if (storedResult.status === 'fulfilled') {
                setStoredSessions(storedResult.value);
            } else {
                setStoredSessions([]);
                errors.push(`History: ${errorText(storedResult.reason)}`);
            }
        }
        if (errors.length > 0) setLoadError(errors.join(' · '));
        setLoading(false);
    }, [client, viewMode, workingDir]);

    useEffect(() => { void refresh(); }, [refresh]);

    const cwdLabel = (cwd: string) => cwd.split('/').pop() || cwd;
    const firstReplayUserLine = (session: CodeSession) => {
        const event = session.replayEvents?.find(e => e.event === 'code_user_message_chunk');
        const update = event?.update ?? {};
        const content = update['content'] as { type?: string; text?: string } | undefined;
        const text = String(content?.text ?? update['text'] ?? '').split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim();
        return text || '';
    };
    const liveSessionTitle = (session: CodeSession) => session.title?.trim()
        || firstReplayUserLine(session)
        || cwdLabel(session.cwd)
        || session.sessionId.slice(0, 12)
        || 'Untitled session';
    const liveSessionMeta = (session: CodeSession) => cwdLabel(session.cwd);
    const liveSessionSearchText = (session: CodeSession) => [
        session.sessionId,
        session.title ?? '',
        firstReplayUserLine(session),
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
    const groupedStoredSessions = visibleStoredSessions.reduce<Array<{ cwd: string; sessions: StoredSession[] }>>((groups, session) => {
        const existing = groups.find(group => group.cwd === session.cwd);
        if (existing) existing.sessions.push(session);
        else groups.push({ cwd: session.cwd, sessions: [session] });
        return groups;
    }, []);
    const emptyText = loadError
        ? 'Session data could not fully load.'
        : viewMode === 'cwd'
            ? 'No sessions for this cwd. Switch to All to browse global history.'
            : 'No JWC sessions found.';

    return (
        <div className="code-session-list">
            <div className="code-session-list-header">
                <span className="code-session-list-title">Sessions</span>
                <button type="button" className="code-session-new-btn" onClick={onNewSession} aria-label="New code session">+</button>
            </div>
            <div className="code-session-view-toggle" aria-label="Session view">
                <button type="button" className={`code-session-view-btn${viewMode === 'all' ? ' active' : ''}`} onClick={() => setViewMode('all')}>All</button>
                <button type="button" className={`code-session-view-btn${viewMode === 'cwd' ? ' active' : ''}`} onClick={() => setViewMode('cwd')}>This cwd</button>
                <button type="button" className={`code-session-view-btn${viewMode === 'grouped' ? ' active' : ''}`} onClick={() => setViewMode('grouped')}>Group</button>
            </div>
            {viewMode === 'cwd' && <div className="code-session-view-hint">{cwdLabel(workingDir)}</div>}
            {loadError && <div className="code-session-list-error" role="status">{loadError}</div>}
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
                                        onClick={() => onSelectSession(s)}>
                                        <span className="code-session-cwd">{liveSessionTitle(s)}</span>
                                        <span className="code-session-meta">{liveSessionMeta(s)}</span>
                                        <span className={`code-session-status code-session-status-${s.status}`}>{s.status}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {visibleStoredSessions.length > 0 && viewMode !== 'grouped' && (
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
                    {visibleStoredSessions.length > 0 && viewMode === 'grouped' && (
                        <>
                            <div className="code-session-list-divider">History by cwd</div>
                            {groupedStoredSessions.map(group => (
                                <section className="code-session-group" key={group.cwd}>
                                    <div className="code-session-group-title" title={group.cwd}>{cwdLabel(group.cwd)} <span>{group.sessions.length}</span></div>
                                    <ul className="code-session-list-items">
                                        {group.sessions.map(s => (
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
                                </section>
                            ))}
                        </>
                    )}
                    {sessions.length === 0 && visibleStoredSessions.length === 0 && (
                        <div className="code-session-list-empty">{emptyText}</div>
                    )}
                </>
            )}
        </div>
    );
}
