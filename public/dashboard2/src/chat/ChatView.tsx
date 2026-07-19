// 045 — persistent ChatView host in the workbench LEFT column (v4 §1/§3.2).
// Owns one TurnStore per (port, sessionId) scope, wires the 032 sync-provider
// subscription surfaces to reducer actions, and stacks committed list + live
// tail + composer inside one 700px content wrapper. The transport stays
// provider-owned: this component never creates an EventSource.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { SessionScope } from '../state/scope.tsx';
import { useManagerApi } from '../providers/api-provider.tsx';
import { useManagerSync } from '../providers/sync-provider.tsx';
import type { AgentDoneSsePayload } from '../../../../src/shared/chat-events.ts';
import { createTurnStore } from '../turn-stream/store/turn-store.ts';
import { attachSyncInvalidation } from '../turn-stream/store/sync-turn-store.ts';
import {
    normalizeAgentDone,
    normalizeAgentOutput,
    normalizeAgentTool,
} from '../turn-stream/hydrate.ts';
import { createStreamScheduler } from '../turn-stream/live/stream-scheduler.ts';
import type { TurnStreamAction } from '../turn-stream/types.ts';
import { useLiveTurns } from '../turn-stream/store/use-turn.ts';
import { TurnStreamViewport } from '../turn-stream/components/TurnStreamViewport.tsx';
import { LiveTurnTail } from '../turn-stream/live/LiveTurnTail.tsx';
import { createMessagesPageClient } from '../turn-stream/history/messages-page-client.ts';
import { createHistoryController } from '../turn-stream/history/history-controller.ts';
import { HistoryLoadBoundary } from '../turn-stream/history/HistoryLoadBoundary.tsx';
import { Composer, type ComposerEcho, type ComposerRegistration } from './composer/Composer.tsx';
import { RenderActionPortsProvider } from '../providers/render-action-ports.tsx';
import { createPendingQueueApi } from './pending/pending-queue-api.ts';
import { PendingQueueMachine } from './pending/pending-queue-machine.ts';
import { createPendingQueueStore } from './pending/pending-queue-store.ts';
import { PendingQueueView } from './pending/PendingQueue.tsx';
import { modelPickerOptions } from '../models/ModelPicker.tsx';
import { useInstanceModelSettings } from '../models/use-instance-model-settings.ts';
import { HoverDock } from '../features/hover-dock/HoverDock.tsx';

// per-scope draft preservation across pane/tab round-trips (045 §5)
const scopeDrafts = new Map<string, string>();

export interface ChatViewProps {
    scope: SessionScope;
}

export function ChatView({ scope }: ChatViewProps): JSX.Element {
    const api = useManagerApi();
    const sync = useManagerSync();
    const scopeKey = `${scope.port}/${scope.sessionId}`;
    const store = useMemo(
        () => createTurnStore(scopeKey, { sessionFilter: scope.sessionId || null }),
        [scopeKey, scope.sessionId],
    );
    const pendingStore = useMemo(
        () => createPendingQueueStore(new PendingQueueMachine(createPendingQueueApi(scope.port))),
        [scope.port],
    );
    // pending store lifetime is keyed to its own identity (per port): a
    // same-port session switch must NOT dispose the reused store
    useEffect(() => () => pendingStore.dispose(), [pendingStore]);
    // 048 history paging: cursor pages + bounded replay-gap backfill live in
    // the controller; ChatView only wires scope + subscriptions
    const historyController = useMemo(() => createHistoryController({
        client: createMessagesPageClient(opts => api.instance(scope.port).fetchMessagesPage(opts)),
        apply: actions => store.ingest(actions),
        getExistingRowKeys: () => store.getRowKeys(),
    }), [api, scope.port, store]);

    useEffect(() => {
        // lifecycle + body + invalidation + replay_gap backfill wiring
        // (single-owner subscriptions; disposed with the scope)
        // body chunks batch at most once per animation frame (045 §5): the
        // scheduler owns frame pacing, the pending array owns the actions
        const pendingBody = new Map<string, TurnStreamAction[]>();
        const traceKeys = new Map<string, string>();
        const turnTraces = new Map<string, Set<string>>();
        const scheduler = createStreamScheduler((key) => {
            const actions = pendingBody.get(key);
            if (!actions?.length) return;
            store.ingest(actions.splice(0, actions.length));
            pendingBody.delete(key);
        });
        const schedulerKeyForTrace = (traceRunId: string): string => {
            const fallbackKey = `trace:${traceRunId}`;
            const resolvedTurnId = store.resolveTurnIdForTrace(traceRunId);
            const previousKey = traceKeys.get(traceRunId);
            if (resolvedTurnId) {
                if (previousKey === fallbackKey) {
                    scheduler.flushTurn(fallbackKey);
                    scheduler.resetTurn(fallbackKey);
                }
                scheduler.beginTurn(resolvedTurnId);
                traceKeys.set(traceRunId, resolvedTurnId);
                const traces = turnTraces.get(resolvedTurnId) ?? new Set<string>();
                traces.add(traceRunId);
                turnTraces.set(resolvedTurnId, traces);
                return resolvedTurnId;
            }
            const key = previousKey ?? fallbackKey;
            traceKeys.set(traceRunId, key);
            scheduler.beginTurn(key);
            return key;
        };
        const queueBody = (key: string, action: TurnStreamAction, chunk: string): void => {
            const actions = pendingBody.get(key) ?? [];
            if (!pendingBody.has(key)) pendingBody.set(key, actions);
            actions.push(action);
            scheduler.push(key, chunk);
        };
        const offLifecycle = sync.subscribeTurnLifecycle(payload => {
            store.ingest({ kind: 'lifecycle', payload });
            if (payload.event === 'turn_start') scheduler.beginTurn(payload.turnId);
        });
        const offBody = sync.subscribeAgentBody(payload => {
            const traceRunId = typeof payload.traceRunId === 'string' && payload.traceRunId
                ? payload.traceRunId
                : 'unknown';
            if (payload.event === 'agent_output' || payload.event === 'agent_chunk') {
                queueBody(schedulerKeyForTrace(traceRunId), normalizeAgentOutput(payload), payload.text ?? '');
            } else if (payload.event === 'agent_tool') {
                queueBody(schedulerKeyForTrace(traceRunId), normalizeAgentTool(payload), '');
            } else {
                // agent_done finalizes immediately: flush pending then ingest
                const activeKey = schedulerKeyForTrace(traceRunId);
                scheduler.flushTurn(activeKey);
                store.ingest(normalizeAgentDone(payload as AgentDoneSsePayload));
                const turnId = store.resolveTurnIdForTrace(traceRunId);
                if (turnId) {
                    scheduler.flushTurn(turnId);
                    scheduler.resetTurn(turnId);
                    const traces = turnTraces.get(turnId) ?? new Set([traceRunId]);
                    for (const trace of traces) {
                        const fallbackKey = `trace:${trace}`;
                        scheduler.flushTurn(fallbackKey);
                        scheduler.resetTurn(fallbackKey);
                        traceKeys.delete(trace);
                    }
                    turnTraces.delete(turnId);
                } else {
                    scheduler.resetTurn(activeKey);
                    traceKeys.delete(traceRunId);
                }
            }
        });
        const offInvalidation = attachSyncInvalidation(store, sync.subscribeInvalidation);
        const offSystem = sync.subscribeSystem(payload => {
            if (payload.event === 'replay_gap') void historyController.handleReplayGap();
        });
        // queue snapshots are server-authoritative (047): typed subscription
        pendingStore.setScope(scopeKey);
        const offQueue = sync.subscribeQueueUpdate(payload => {
            pendingStore.ingest(scopeKey, payload.queued ?? []);
        });
        historyController.setScope(scopeKey);
        void historyController.loadInitial();
        return () => {
            offLifecycle();
            offBody();
            scheduler.resetAll();
            scheduler.dispose();
            offInvalidation();
            offSystem();
            offQueue();
            historyController.abort();
            store.dispose();
        };
    }, [store, pendingStore, historyController, sync, api, scope.port, scopeKey]);

    const [echoes, setEchoes] = useState<ComposerEcho[]>([]);
    const composer = useRef<ComposerRegistration | null>(null);
    const [announcement, setAnnouncement] = useState('');
    const ports = useMemo(() => ({
        workerPort: scope.port,
        submitMessage: (prompt: string) => composer.current ? composer.current.submitMessage(prompt) : Promise.reject(new Error('No composer is registered for this chat.')),
        copyText: (text: string) => navigator.clipboard?.writeText(text) ?? Promise.resolve(),
        openExternal: (url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); },
        openProtocol: (url: string) => { if (/^(?:mailto|sms):/i.test(url)) window.location.href = url; },
        announce: setAnnouncement,
    }), [scope.port]);

    return (
        <RenderActionPortsProvider ports={ports}><div className="d2-chat-view" data-testid="chat-view">
            <HoverDock key={scope.port} port={scope.port} />
            <div className="d2-chat-content">
                <TurnStreamViewport
                    store={store}
                    head={<HistoryLoadBoundary controller={historyController} />}
                    tail={<LiveTurnTail store={store} />}
                />
                {echoes.filter(echo => echo.status === 'sending' || echo.status === 'error').map(echo => (
                    <div key={echo.id} className="d2-chat-echo" data-status={echo.status}>
                        {echo.prompt}
                    </div>
                ))}
            </div>
            <PendingQueueView store={pendingStore} />
            <ChatComposerSlot store={store} scopeKey={scopeKey} port={scope.port} onRegister={registration => { composer.current = registration; }} onEcho={(echo) => {
                setEchoes(current => {
                    const rest = current.filter(item => item.id !== echo.id);
                    return [...rest.slice(-9), echo];
                });
            }} />
            <div className="d2-sr-only" aria-live="polite">{announcement}</div>
        </div></RenderActionPortsProvider>
    );
}

interface ChatComposerSlotProps {
    store: ReturnType<typeof createTurnStore>;
    scopeKey: string;
    port: number;
    onEcho(echo: ComposerEcho): void;
    onRegister(registration: ComposerRegistration | null): void;
}

function ChatComposerSlot({ store, scopeKey, port, onEcho, onRegister }: ChatComposerSlotProps): JSX.Element {
    const live = useLiveTurns(store);
    const api = useManagerApi();
    const sync = useManagerSync();
    const [orcPhase, setOrcPhase] = useState<string | null>(null);
    const modelSettings = useInstanceModelSettings({ port, mode: 'active' });
    const pickerOptions = useMemo(
        () => modelPickerOptions(modelSettings.snapshot.catalog, modelSettings.snapshot.selection),
        [modelSettings.snapshot.catalog, modelSettings.snapshot.selection],
    );
    const pickerValue = pickerOptions.find(option => (
        option.provider === modelSettings.snapshot.selection?.provider
        && option.model === modelSettings.snapshot.selection?.model
    )) ?? null;

    useEffect(() => {
        // Reset phase on scope change to avoid stale cross-instance data
        setOrcPhase(null);
        return sync.subscribeOrcState((payload) => {
            setOrcPhase(payload.state || null);
        });
    }, [sync, scopeKey]);

    return (
        <div className="d2-chat-composer-slot">
            <Composer
                key={scopeKey}
                port={port}
                initialDraft={scopeDrafts.get(scopeKey) ?? ''}
                onDraftChange={(draft) => scopeDrafts.set(scopeKey, draft)}
                picker={{
                    value: pickerValue,
                    options: pickerOptions,
                    effort: modelSettings.snapshot.selection?.effort ?? '',
                    loading: modelSettings.snapshot.status === 'loading',
                    pending: modelSettings.snapshot.status === 'saving',
                    disabled: !modelSettings.snapshot.catalog?.mutationEnabled,
                    error: modelSettings.snapshot.error?.message ?? null,
                    workerWide: true,
                    onSelect: option => {
                        const selection = modelSettings.snapshot.selection;
                        if (!selection) return;
                        void modelSettings.actions.save({
                            ...selection,
                            provider: option.provider,
                            model: option.model,
                        });
                    },
                }}
                isRunning={live.turnIds.length > 0}
                phase={orcPhase}
                onStop={() => { void api.instance(port).stopAgent().catch(() => { /* snapshot recovers */ }); }}
                onEcho={onEcho}
                onRegister={onRegister}
            />
        </div>
    );
}
