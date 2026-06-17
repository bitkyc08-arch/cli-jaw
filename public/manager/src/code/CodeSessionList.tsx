import { useCallback, useEffect, useState } from 'react';
import type { CodeSession, CodeSessionClient } from './code-session-client';

type CodeSessionListProps = {
    client: CodeSessionClient;
    activeSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    onNewSession: () => void;
};

export function CodeSessionList({ client, activeSessionId, onSelectSession, onNewSession }: CodeSessionListProps) {
    const [sessions, setSessions] = useState<CodeSession[]>([]);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const list = await client.listSessions();
            setSessions(list.filter(s => s.status !== 'closed'));
        } catch {
            setSessions([]);
        } finally {
            setLoading(false);
        }
    }, [client]);

    useEffect(() => { void refresh(); }, [refresh]);

    return (
        <div className="code-session-list">
            <div className="code-session-list-header">
                <span className="code-session-list-title">Code Sessions</span>
                <button type="button" className="code-session-new-btn" onClick={onNewSession} aria-label="New code session">+</button>
            </div>
            {loading ? (
                <div className="code-session-list-loading">Loading...</div>
            ) : sessions.length === 0 ? (
                <div className="code-session-list-empty">No active sessions. Type a prompt to start.</div>
            ) : (
                <ul className="code-session-list-items">
                    {sessions.map(s => (
                        <li key={s.sessionId}>
                            <button
                                type="button"
                                className={`code-session-item ${s.sessionId === activeSessionId ? 'active' : ''}`}
                                onClick={() => onSelectSession(s.sessionId)}
                            >
                                <span className="code-session-cwd">{s.cwd.split('/').pop()}</span>
                                <span className={`code-session-status code-session-status-${s.status}`}>{s.status}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
