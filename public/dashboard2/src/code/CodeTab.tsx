// 060 — Code tab: composes the Code source adapter with the SHARED turn
// stream renderer (TurnStreamViewport + CodeLiveTail). Lives entirely inside
// the lazy code/ chunk; the transport stays provider-owned (single
// EventSource via useManagerSync().subscribeJwc — never a second one).
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useManagerApi } from '../providers/api-provider.tsx';
import { useManagerSync } from '../providers/sync-provider.tsx';
import { createTurnStore } from '../turn-stream/store/turn-store.ts';
import { TurnStreamViewport } from '../turn-stream/components/TurnStreamViewport.tsx';
import type { CodeSessionInfo } from '../../../../src/code-mode/types.ts';
import { createCodeApiClient } from './code-api-client.ts';
import { createCodeSourceAdapter } from './code-source-adapter.ts';
import type { JwcPermissionEvent } from './code-event-types.ts';
import { loadSessionHistory, type CodeHistorySummary } from './code-history-adapter.ts';
import { CodeHistoryList } from './CodeHistoryList.tsx';
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

    // single-owner live subscription: adapter filters by sessionId internally
    useEffect(() => {
        if (!store || !adapter) return;
        return sync.subscribeJwc(payload => {
            const actions = adapter.ingestLive(payload);
            if (actions.length) store.ingest(actions);
        });
    }, [sync, store, adapter]);

    useEffect(() => () => { store?.dispose(); }, [store]);

    function openStoredSession(entry: CodeHistorySummary): void {
        // the load runs AFTER the session-scoped store/adapter remount below
        replaySeededRef.current = null;
        pendingEntryRef.current = entry;
        setListError(null);
        setSessionId(entry.sessionId);
    }

    const pendingEntryRef = useRef<CodeHistorySummary | null>(null);
    useEffect(() => {
        if (!store || !adapter || !sessionId) return;
        const entry = pendingEntryRef.current;
        if (!entry || entry.sessionId !== sessionId) return;
        if (replaySeededRef.current === sessionId) return;
        replaySeededRef.current = sessionId;
        pendingEntryRef.current = null;
        void loadSessionHistory(client, entry, adapter).then(({ actions }) => {
            if (actions.length) store.ingest(actions);
        }).catch((error: unknown) => {
            setListError(error instanceof Error ? error.message : String(error));
        });
    }, [store, adapter, sessionId, client]);

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
            pendingEntryRef.current = null;
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
                <CodeHistoryList
                    client={client}
                    onNewSession={() => { void startNewSession(); }}
                    onSelectLive={(session: CodeSessionInfo) => {
                        replaySeededRef.current = null;
                        pendingEntryRef.current = null;
                        setSessionId(session.sessionId);
                    }}
                    onSelectStored={openStoredSession}
                />
                {listError ? <div className="d2-code-error" role="alert">{listError}</div> : null}
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
