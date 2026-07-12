import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    type JSX,
    type PropsWithChildren,
} from 'react';
import type {
    AgentDoneSsePayload,
    AgentOutputSsePayload,
    AgentToolSsePayload,
    QueueUpdateSsePayload,
} from '../../../../src/shared/chat-events.ts';
import type { TurnLifecycleSsePayload } from '../../../../src/shared/chat-events.ts';
import { useAppScope } from '../state/scope.tsx';

export interface SystemSsePayload {
    topic: 'system';
    event: 'replay_gap' | 'turn_segment_error';
    sseReplay?: boolean;
    [key: string]: unknown;
}

export type SyncInvalidationReason = 'replay_gap' | 'reconnect' | 'port_change';

// legacy body channels (041 §2.1): bodies only — turn order/status stay with
// the lifecycle channel; consumers normalize via turn-stream/hydrate.ts
export type AgentBodySsePayload = AgentOutputSsePayload | AgentToolSsePayload | AgentDoneSsePayload;

export interface ManagerSyncContextValue {
    subscribeTurnLifecycle(cb: (payload: TurnLifecycleSsePayload) => void): () => void;
    subscribeAgentBody(cb: (payload: AgentBodySsePayload) => void): () => void;
    subscribeQueueUpdate(cb: (payload: QueueUpdateSsePayload) => void): () => void;
    subscribeSystem(cb: (payload: SystemSsePayload) => void): () => void;
    subscribeInvalidation(cb: (reason: SyncInvalidationReason) => void): () => void;
    subscribeOrcState(cb: (payload: OrcStateSsePayload) => void): () => void;
}

export interface OrcStateSsePayload {
    topic: 'orchestrate';
    event: 'orc_state';
    state: string;
    title?: string;
    scope?: string;
    [key: string]: unknown;
}

type SseEnvelope = {
    topic?: unknown;
    event?: unknown;
    [key: string]: unknown;
};

export interface SyncPayloadDispatchers {
    turn(payload: TurnLifecycleSsePayload): void;
    body(payload: AgentBodySsePayload): void;
    queue(payload: QueueUpdateSsePayload): void;
    system(payload: SystemSsePayload): void;
    orcState?(payload: OrcStateSsePayload): void;
}

const TURN_LIFECYCLE_EVENTS = new Set(['turn_start', 'turn_segment', 'turn_end']);
const AGENT_BODY_EVENTS = new Set(['agent_output', 'agent_chunk', 'agent_tool', 'agent_done']);
const SYSTEM_EVENTS = new Set(['replay_gap', 'turn_segment_error']);
const ORC_STATE_EVENTS = new Set(['orc_state']);

const ManagerSyncContext = createContext<ManagerSyncContextValue | null>(null);

function subscribe<T>(subscribers: Set<(value: T) => void>, cb: (value: T) => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
}

function publish<T>(subscribers: Set<(value: T) => void>, value: T): void {
    for (const subscriber of subscribers) subscriber(value);
}

export function dispatchSelectedSyncPayload(
    payload: SseEnvelope,
    dispatchers: SyncPayloadDispatchers,
): 'turn' | 'body' | 'queue' | 'system' | null {
    if (payload.topic === 'orchestrate'
        && typeof payload.event === 'string'
        && ORC_STATE_EVENTS.has(payload.event)) {
        dispatchers.orcState?.(payload as unknown as OrcStateSsePayload);
        return 'system';
    }
    if (payload.topic === 'agent'
        && typeof payload.event === 'string'
        && TURN_LIFECYCLE_EVENTS.has(payload.event)) {
        dispatchers.turn(payload as unknown as TurnLifecycleSsePayload);
        return 'turn';
    }
    if (payload.topic === 'agent'
        && typeof payload.event === 'string'
        && AGENT_BODY_EVENTS.has(payload.event)) {
        dispatchers.body(payload as unknown as AgentBodySsePayload);
        return 'body';
    }
    if (payload.topic === 'queue' && payload.event === 'queue_update') {
        dispatchers.queue(payload as unknown as QueueUpdateSsePayload);
        return 'queue';
    }
    if (payload.topic === 'system'
        && typeof payload.event === 'string'
        && SYSTEM_EVENTS.has(payload.event)) {
        dispatchers.system(payload as SystemSsePayload);
        return 'system';
    }
    return null;
}

// Mounted once per app root so one selected instance owns one EventSource.
export function ManagerSyncProvider(props: PropsWithChildren): JSX.Element {
    const { selected } = useAppScope();
    const selectedPort = selected?.port ?? null;
    const turnSubscribersRef = useRef(new Set<(payload: TurnLifecycleSsePayload) => void>());
    const bodySubscribersRef = useRef(new Set<(payload: AgentBodySsePayload) => void>());
    const systemSubscribersRef = useRef(new Set<(payload: SystemSsePayload) => void>());
    const queueSubscribersRef = useRef(new Set<(payload: QueueUpdateSsePayload) => void>());
    const invalidationSubscribersRef = useRef(new Set<(reason: SyncInvalidationReason) => void>());
    const generationRef = useRef(0);
    const lastEventIdByPortRef = useRef(new Map<number, string>());
    const previousPortRef = useRef<number | null | undefined>(undefined);

    const orcStateSubscribersRef = useRef(new Set<(payload: OrcStateSsePayload) => void>());

    const value = useMemo<ManagerSyncContextValue>(() => ({
        subscribeTurnLifecycle: (cb) => subscribe(turnSubscribersRef.current, cb),
        subscribeAgentBody: (cb) => subscribe(bodySubscribersRef.current, cb),
        subscribeQueueUpdate: (cb) => subscribe(queueSubscribersRef.current, cb),
        subscribeSystem: (cb) => subscribe(systemSubscribersRef.current, cb),
        subscribeInvalidation: (cb) => subscribe(invalidationSubscribersRef.current, cb),
        subscribeOrcState: (cb) => subscribe(orcStateSubscribersRef.current, cb),
    }), []);

    useEffect(() => {
        const previousPort = previousPortRef.current;
        previousPortRef.current = selectedPort;
        if (previousPort !== undefined && previousPort !== selectedPort) {
            publish(invalidationSubscribersRef.current, 'port_change');
        }
        if (selectedPort === null) return;

        let source: EventSource | null = null;

        const close = (): void => {
            generationRef.current += 1;
            source?.close();
            source = null;
        };

        const open = (): void => {
            if (source || document.hidden) return;
            const generation = ++generationRef.current;
            const lastEventId = lastEventIdByPortRef.current.get(selectedPort);
            const suffix = lastEventId
                ? `?lastEventId=${encodeURIComponent(lastEventId)}`
                : '';
            const nextSource = new EventSource(`/i/${selectedPort}/api/events${suffix}`);
            source = nextSource;

            nextSource.onmessage = (message: MessageEvent<string>) => {
                if (generation !== generationRef.current || source !== nextSource) return;
                if (message.lastEventId) {
                    lastEventIdByPortRef.current.set(selectedPort, message.lastEventId);
                }

                let payload: SseEnvelope;
                try {
                    payload = JSON.parse(String(message.data)) as SseEnvelope;
                } catch {
                    return;
                }

                dispatchSelectedSyncPayload(payload, {
                    turn: value => publish(turnSubscribersRef.current, value),
                    body: value => publish(bodySubscribersRef.current, value),
                    queue: value => publish(queueSubscribersRef.current, value),
                    system: value => {
                        publish(systemSubscribersRef.current, value);
                        if (value.event === 'replay_gap') {
                            publish(invalidationSubscribersRef.current, 'replay_gap');
                        }
                    },
                    orcState: value => publish(orcStateSubscribersRef.current, value),
                });
            };
        };

        const onVisibilityChange = (): void => {
            if (document.hidden) {
                close();
                return;
            }
            publish(invalidationSubscribersRef.current, 'reconnect');
            open();
        };

        open();
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            close();
        };
    }, [selectedPort]);

    return (
        <ManagerSyncContext.Provider value={value}>
            {props.children}
        </ManagerSyncContext.Provider>
    );
}

export function useManagerSync(): ManagerSyncContextValue {
    const sync = useContext(ManagerSyncContext);
    if (!sync) {
        throw new Error('useManagerSync must be used inside ManagerSyncProvider');
    }
    return sync;
}
