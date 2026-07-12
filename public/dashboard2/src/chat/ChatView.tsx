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
import { Composer, type ComposerEcho } from './composer/Composer.tsx';
import { createPendingQueueApi } from './pending/pending-queue-api.ts';
import { PendingQueueMachine } from './pending/pending-queue-machine.ts';
import { createPendingQueueStore } from './pending/pending-queue-store.ts';
import { PendingQueueView } from './pending/PendingQueue.tsx';

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
        const offLifecycle = sync.subscribeTurnLifecycle(payload => {
            store.ingest({ kind: 'lifecycle', payload });
        });
        // body chunks batch at most once per animation frame (045 §5): the
        // scheduler owns frame pacing, the pending array owns the actions
        const pendingBody: TurnStreamAction[] = [];
        const scheduler = createStreamScheduler(() => {
            if (!pendingBody.length) return;
            store.ingest(pendingBody.splice(0, pendingBody.length));
        });
        const offBody = sync.subscribeAgentBody(payload => {
            if (payload.event === 'agent_output' || payload.event === 'agent_chunk') {
                pendingBody.push(normalizeAgentOutput(payload));
                scheduler.push(payload.text ?? '');
            } else if (payload.event === 'agent_tool') {
                pendingBody.push(normalizeAgentTool(payload));
                scheduler.push('');
            } else {
                // agent_done finalizes immediately: flush pending then ingest
                scheduler.flushNow();
                store.ingest(normalizeAgentDone(payload as AgentDoneSsePayload));
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
            scheduler.dispose();
            offInvalidation();
            offSystem();
            offQueue();
            historyController.abort();
            store.dispose();
        };
    }, [store, pendingStore, historyController, sync, api, scope.port, scopeKey]);

    const [echoes, setEchoes] = useState<ComposerEcho[]>([]);

    return (
        <div className="d2-chat-view" data-testid="chat-view">
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
            <ChatComposerSlot store={store} scopeKey={scopeKey} port={scope.port} onEcho={(echo) => {
                setEchoes(current => {
                    const rest = current.filter(item => item.id !== echo.id);
                    return [...rest.slice(-9), echo];
                });
            }} />
        </div>
    );
}

interface ChatComposerSlotProps {
    store: ReturnType<typeof createTurnStore>;
    scopeKey: string;
    port: number;
    onEcho(echo: ComposerEcho): void;
}

function ChatComposerSlot({ store, scopeKey, port, onEcho }: ChatComposerSlotProps): JSX.Element {
    const live = useLiveTurns(store);
    const api = useManagerApi();
    const sync = useManagerSync();
    const [orcPhase, setOrcPhase] = useState<string | null>(null);

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
                initialDraft={scopeDrafts.get(scopeKey) ?? ''}
                onDraftChange={(draft) => scopeDrafts.set(scopeKey, draft)}
                isRunning={live.turnIds.length > 0}
                phase={orcPhase}
                onStop={() => { void api.instance(port).stopAgent().catch(() => { /* snapshot recovers */ }); }}
                onEcho={onEcho}
            />
        </div>
    );
}
