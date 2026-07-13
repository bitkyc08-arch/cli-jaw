// 060 — Code tab: composes the Code source adapter with the SHARED turn
// stream renderer (TurnStreamViewport + CodeLiveTail). Lives entirely inside
// the lazy code/ chunk; the transport stays provider-owned (single
// EventSource via useManagerSync().subscribeJwc — never a second one).
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useManagerApi } from '../providers/api-provider.tsx';
import { useManagerSync } from '../providers/sync-provider.tsx';
import { createTurnStore } from '../turn-stream/store/turn-store.ts';
import { TurnStreamViewport } from '../turn-stream/components/TurnStreamViewport.tsx';
import type { CodeSessionInfo, StoredCodeSessionInfo } from '../../../../src/code-mode/types.ts';
import { createCodeApiClient } from './code-api-client.ts';
import { createCodeSourceAdapter } from './code-source-adapter.ts';
import type { JwcPermissionEvent } from './code-event-types.ts';
import { CodeLiveTail } from './CodeLiveTail.tsx';
import './code-tab.css';

export interface CodeTabProps {
    port: number;
}

interface PermissionOption {
    optionId: string;
    name?: string;
    kind?: string;
}

interface PendingPermission {
    requestId: string;
    options: PermissionOption[];
}

function permissionOptions(event: JwcPermissionEvent): PermissionOption[] {
    if (!Array.isArray(event.options)) return [];
    const parsed: PermissionOption[] = [];
    for (const option of event.options) {
        if (typeof option !== 'object' || option === null) continue;
        const record = option as Record<string, unknown>;
        const optionId = record['optionId'] ?? record['id'];
        if (typeof optionId !== 'string' || !optionId) continue;
        parsed.push({
            optionId,
            ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
            ...(typeof record['kind'] === 'string' ? { kind: record['kind'] } : {}),
        });
    }
    return parsed;
}

export function CodeTab({ port }: CodeTabProps): JSX.Element {
    const api = useManagerApi();
    const sync = useManagerSync();
    const client = useMemo(() => createCodeApiClient(port), [port]);
    const [sessions, setSessions] = useState<CodeSessionInfo[]>([]);
    const [stored, setStored] = useState<StoredCodeSessionInfo[]>([]);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [permissions, setPermissions] = useState<PendingPermission[]>([]);
    const replaySeededRef = useRef<string | null>(null);

    const scopeKey = sessionId ? `code:${port}/${sessionId}` : null;
    const store = useMemo(
        () => (scopeKey && sessionId ? createTurnStore(scopeKey, { sessionFilter: sessionId }) : null),
        [scopeKey, sessionId],
    );
    const adapter = useMemo(
        () => (sessionId ? createCodeSourceAdapter(sessionId, {
            onPermission: (event) => {
                if (!event.requestId) return;
                const next: PendingPermission = {
                    requestId: event.requestId,
                    options: permissionOptions(event),
                };
                setPermissions(current => [...current.filter(p => p.requestId !== next.requestId), next]);
            },
        }) : null),
        [sessionId],
    );

    useEffect(() => {
        let mounted = true;
        void Promise.all([
            client.listSessions().catch(() => [] as CodeSessionInfo[]),
            client.listStoredSessions('all').catch(() => [] as StoredCodeSessionInfo[]),
        ]).then(([live, storedSessions]) => {
            if (!mounted) return;
            setSessions(live);
            setStored(storedSessions);
        }).catch((error: unknown) => {
            if (mounted) setListError(error instanceof Error ? error.message : String(error));
        });
        return () => { mounted = false; };
    }, [client]);

    // single-owner live subscription: adapter filters by sessionId internally
    useEffect(() => {
        if (!store || !adapter) return;
        return sync.subscribeJwc(payload => {
            const actions = adapter.ingestLive(payload);
            if (actions.length) store.ingest(actions);
        });
    }, [sync, store, adapter]);

    useEffect(() => () => { store?.dispose(); }, [store]);

    async function openStoredSession(entry: StoredCodeSessionInfo): Promise<void> {
        try {
            const session = await client.loadSession(entry.sessionId, entry.cwd);
            replaySeededRef.current = null;
            setSessionId(session.sessionId);
            setListError(null);
            // replay seeding happens after the store/adapter remount below
            pendingReplayRef.current = { session };
        } catch (error: unknown) {
            setListError(error instanceof Error ? error.message : String(error));
        }
    }

    const pendingReplayRef = useRef<{ session: CodeSessionInfo } | null>(null);
    useEffect(() => {
        if (!store || !adapter || !sessionId) return;
        const pending = pendingReplayRef.current;
        if (!pending || pending.session.sessionId !== sessionId) return;
        if (replaySeededRef.current === sessionId) return;
        replaySeededRef.current = sessionId;
        pendingReplayRef.current = null;
        const records = Array.isArray(pending.session.replayEvents) ? pending.session.replayEvents : [];
        const actions = adapter.ingestReplay(records, { status: pending.session.status });
        if (actions.length) store.ingest(actions);
    }, [store, adapter, sessionId]);

    async function startNewSession(): Promise<void> {
        try {
            const instances = await api.fetchInstances();
            const cwd = instances.find(instance => instance.port === port)?.workingDir;
            if (!cwd) {
                setListError('No working directory for this instance');
                return;
            }
            const session = await client.newSession(cwd);
            replaySeededRef.current = null;
            pendingReplayRef.current = null;
            setSessionId(session.sessionId);
            setListError(null);
        } catch (error: unknown) {
            setListError(error instanceof Error ? error.message : String(error));
        }
    }

    async function sendPrompt(): Promise<void> {
        if (!sessionId || !adapter || !store) return;
        const text = draft.trim();
        if (!text || busy) return;
        setBusy(true);
        try {
            await client.prompt(sessionId, text);
            store.ingest(adapter.notePromptAccepted(text));
            setDraft('');
        } catch (error: unknown) {
            setListError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    async function answerPermission(requestId: string, optionId: string): Promise<void> {
        try {
            await client.answerPermission(requestId, optionId);
        } finally {
            setPermissions(current => current.filter(p => p.requestId !== requestId));
        }
    }

    if (!sessionId || !store) {
        return (
            <div className="d2-code-tab" data-testid="code-tab">
                <div className="d2-code-session-picker">
                    <button type="button" className="d2-code-new-session" onClick={() => { void startNewSession(); }}>
                        New Code session
                    </button>
                    {sessions.map(session => (
                        <button
                            key={session.sessionId}
                            type="button"
                            className="d2-code-session-row"
                            onClick={() => { replaySeededRef.current = null; pendingReplayRef.current = null; setSessionId(session.sessionId); }}
                        >
                            <strong>{session.title || session.sessionId.slice(0, 8)}</strong>
                            <span>{session.cwd}</span>
                        </button>
                    ))}
                    {stored.map(entry => (
                        <button
                            key={entry.sessionId}
                            type="button"
                            className="d2-code-session-row"
                            onClick={() => { void openStoredSession(entry); }}
                        >
                            <strong>{entry.title || entry.firstMessage || entry.sessionId.slice(0, 8)}</strong>
                            <span>{entry.cwd}</span>
                        </button>
                    ))}
                    {!sessions.length && !stored.length ? (
                        <div className="d2-pane-empty">No Code sessions yet</div>
                    ) : null}
                    {listError ? <div className="d2-code-error" role="alert">{listError}</div> : null}
                </div>
            </div>
        );
    }

    return (
        <div className="d2-code-tab" data-testid="code-tab">
            <div className="d2-code-stream">
                <TurnStreamViewport store={store} tail={<CodeLiveTail store={store} />} />
            </div>
            {permissions.map(permission => (
                <div key={permission.requestId} className="d2-code-permission" role="group">
                    <span>Permission requested</span>
                    {permission.options.map(option => (
                        <button
                            key={option.optionId}
                            type="button"
                            onClick={() => { void answerPermission(permission.requestId, option.optionId); }}
                        >
                            {option.name || option.optionId}
                        </button>
                    ))}
                </div>
            ))}
            <div className="d2-code-composer">
                <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void sendPrompt();
                        }
                    }}
                    placeholder="Ask Code..."
                    rows={2}
                />
                <div className="d2-code-composer-actions">
                    <button type="button" onClick={() => { void client.cancel(sessionId); }}>Stop</button>
                    <button type="button" disabled={!draft.trim() || busy} onClick={() => { void sendPrompt(); }}>Send</button>
                </div>
            </div>
            {listError ? <div className="d2-code-error" role="alert">{listError}</div> : null}
        </div>
    );
}

export default CodeTab;
