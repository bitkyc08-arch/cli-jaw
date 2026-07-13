// 061 — stored/live Code session list (extracted from CodeTab's inline
// picker). Consumes the D6=B history projection; list states are explicit
// (loading/ready/empty/error) — an unavailable runtime never renders as a
// silent empty list (the gate blocks entry before this mounts).
import { useEffect, useState, type JSX } from 'react';
import type { CodeSessionInfo } from '../../../../src/code-mode/types.ts';
import type { CodeApiClient } from './code-api-client.ts';
import { fetchHistorySummaries, type CodeHistoryListState, type CodeHistorySummary } from './code-history-adapter.ts';

export interface CodeHistoryListProps {
    client: CodeApiClient;
    onSelectLive(session: CodeSessionInfo): void;
    onSelectStored(summary: CodeHistorySummary): void;
    onNewSession(): void;
}

export function CodeHistoryList({ client, onSelectLive, onSelectStored, onNewSession }: CodeHistoryListProps): JSX.Element {
    const [live, setLive] = useState<CodeSessionInfo[]>([]);
    const [history, setHistory] = useState<CodeHistoryListState>({ state: 'loading' });

    useEffect(() => {
        let mounted = true;
        void client.listSessions()
            .then(sessions => { if (mounted) setLive(sessions); })
            .catch(() => { /* live list is best-effort; stored state carries errors */ });
        void fetchHistorySummaries(client).then(state => {
            if (mounted) setHistory(state);
        });
        return () => { mounted = false; };
    }, [client]);

    return (
        <div className="d2-code-session-picker" data-testid="code-history-list" data-history-state={history.state}>
            <button type="button" className="d2-code-new-session" onClick={onNewSession}>
                New Code session
            </button>
            {live.map(session => (
                <button
                    key={session.sessionId}
                    type="button"
                    className="d2-code-session-row"
                    data-live="1"
                    onClick={() => onSelectLive(session)}
                >
                    <strong>{session.title || session.sessionId.slice(0, 8)}</strong>
                    <span>{session.cwd}</span>
                </button>
            ))}
            {history.state === 'loading' ? (
                <div className="d2-pane-empty">Loading Code history…</div>
            ) : history.state === 'empty' && !live.length ? (
                <div className="d2-pane-empty">No Code sessions yet</div>
            ) : history.state === 'error' ? (
                <div className="d2-code-error" role="alert">History unavailable: {history.message}</div>
            ) : history.state === 'unavailable' ? (
                <div className="d2-code-error" role="status">{history.message}</div>
            ) : null}
            {history.state === 'ready' ? history.summaries.map(summary => (
                <button
                    key={summary.sessionId}
                    type="button"
                    className="d2-code-session-row"
                    onClick={() => onSelectStored(summary)}
                >
                    <strong>{summary.title}</strong>
                    <span>{summary.cwd}</span>
                </button>
            )) : null}
        </div>
    );
}
