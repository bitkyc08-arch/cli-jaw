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
import { SseConnection, type SseSourceLike } from './sse-connection.ts';

export interface SystemSsePayload {
    topic: 'system';
    event: 'replay_gap' | 'turn_segment_error' | 'ping';
    sseReplay?: boolean;
    [key: string]: unknown;
}

// 060 — Code ('jwc' topic) SSE envelope. The provider owns the transport and
// connection-local `sseEventId` injection (MessageEvent.lastEventId); all
// semantic mapping stays inside the lazy code/ chunk. This type carries no
// Code module import — it is the wire boundary only.
export interface JwcSsePayload {
    topic: 'jwc';
    event: `code_${string}`;
    sessionId?: string;
    update?: Record<string, unknown>;
    sseReplay?: boolean;
    /** connection-local dedupe/cursor hint — never a durable identity */
    sseEventId?: string;
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
    subscribeJwc(cb: (payload: JwcSsePayload) => void): () => void;
    subscribeManagerWorker(cb: (payload: ManagerWorkerSsePayload) => void): () => void;
}

export interface ManagerInstanceStatusChangedSsePayload {
    topic: 'worker';
    event: 'instance-status-changed';
    port: number;
    change: 'appeared' | 'disappeared' | 'status' | 'version';
    prev?: { status: string; version: string | null };
    next?: { status: string; version: string | null };
    sseReplay?: boolean;
}

export interface ManagerWorkerSettingsChangedSsePayload {
    topic: 'worker';
    event: 'worker_settings_change';
    port: number;
    changedKeys: string[] | null;
    sseReplay?: boolean;
}

export type ManagerWorkerSsePayload =
    | ManagerInstanceStatusChangedSsePayload
    | ManagerWorkerSettingsChangedSsePayload;

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
    jwc?(payload: JwcSsePayload): void;
    managerWorker?(payload: ManagerWorkerSsePayload): void;
}

const TURN_LIFECYCLE_EVENTS = new Set(['turn_start', 'turn_segment', 'turn_end']);
const AGENT_BODY_EVENTS = new Set(['agent_output', 'agent_chunk', 'agent_tool', 'agent_done']);
const SYSTEM_EVENTS = new Set(['replay_gap', 'turn_segment_error', 'ping']);
const ORC_STATE_EVENTS = new Set(['orc_state']);
const ManagerSyncContext = createContext<ManagerSyncContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPort(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535;
}

function createBrowserSseSource(url: string): SseSourceLike {
    const nativeSource = new EventSource(url);
    const source: SseSourceLike = {
        onmessage: null,
        onerror: null,
        close: () => nativeSource.close(),
    };
    nativeSource.onmessage = event => source.onmessage?.({
        data: String(event.data),
        ...(event.lastEventId ? { lastEventId: event.lastEventId } : {}),
    });
    nativeSource.onerror = () => source.onerror?.();
    return source;
}

function isInstanceState(value: unknown): value is { status: string; version: string | null } {
    return isRecord(value)
        && typeof value['status'] === 'string'
        && (value['version'] === null || typeof value['version'] === 'string');
}

function replayField(payload: Record<string, unknown>): { sseReplay?: boolean } | null {
    if (!('sseReplay' in payload)) return {};
    return typeof payload['sseReplay'] === 'boolean'
        ? { sseReplay: payload['sseReplay'] }
        : null;
}

function parseManagerWorkerPayload(value: unknown): ManagerWorkerSsePayload | null {
    if (!isRecord(value) || value['topic'] !== 'worker' || !isPort(value['port'])) return null;
    const replay = replayField(value);
    if (!replay) return null;

    if (value['event'] === 'worker_settings_change') {
        const changedKeys = value['changedKeys'];
        if (changedKeys !== null
            && (!Array.isArray(changedKeys) || !changedKeys.every(key => typeof key === 'string'))) return null;
        return {
            topic: 'worker',
            event: 'worker_settings_change',
            port: value['port'],
            changedKeys: changedKeys === null ? null : [...changedKeys],
            ...replay,
        };
    }

    if (value['event'] !== 'instance-status-changed'
        || !['appeared', 'disappeared', 'status', 'version'].includes(String(value['change']))) return null;
    const change = value['change'] as ManagerInstanceStatusChangedSsePayload['change'];
    const hasPrev = 'prev' in value;
    const hasNext = 'next' in value;
    const prev = value['prev'];
    const next = value['next'];
    if (change === 'appeared') {
        if (hasPrev || !hasNext || !isInstanceState(next)) return null;
        return { topic: 'worker', event: 'instance-status-changed', port: value['port'], change, next, ...replay };
    }
    if (change === 'disappeared') {
        if (!hasPrev || hasNext || !isInstanceState(prev)) return null;
        return { topic: 'worker', event: 'instance-status-changed', port: value['port'], change, prev, ...replay };
    }
    if (!hasPrev || !hasNext || !isInstanceState(prev) || !isInstanceState(next)) return null;
    return { topic: 'worker', event: 'instance-status-changed', port: value['port'], change, prev, next, ...replay };
}

function subscribe<T>(subscribers: Set<(value: T) => void>, cb: (value: T) => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
}

function publish<T>(subscribers: Set<(value: T) => void>, value: T): void {
    for (const subscriber of subscribers) subscriber(value);
}

export function dispatchSelectedSyncPayload(
    value: unknown,
    dispatchers: SyncPayloadDispatchers,
    sseEventId?: string,
): 'turn' | 'body' | 'queue' | 'system' | null {
    if (!isRecord(value)) return null;
    const payload: SseEnvelope = value;
    if (payload.topic === 'jwc'
        && typeof payload.event === 'string'
        && payload.event.startsWith('code_')) {
        const jwcPayload = sseEventId
            ? { ...payload, sseEventId } as unknown as JwcSsePayload
            : payload as unknown as JwcSsePayload;
        dispatchers.jwc?.(jwcPayload);
        return 'system';
    }
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

export function dispatchSyncPayloadForSource(
    source: 'manager' | 'worker',
    payload: unknown,
    dispatchers: SyncPayloadDispatchers,
    sseEventId?: string,
): ReturnType<typeof dispatchSelectedSyncPayload> | 'manager-worker' {
    if (source === 'worker') return dispatchSelectedSyncPayload(payload, dispatchers, sseEventId);
    const managerWorkerPayload = parseManagerWorkerPayload(payload);
    if (managerWorkerPayload) {
        dispatchers.managerWorker?.(managerWorkerPayload);
        return 'manager-worker';
    }
    // Manager system frames are transport health/replay annotations only. JWC,
    // agent, turn, body, queue, orchestrate, and unknown topics are worker-owned.
    return null;
}

// Mounted once per app root: one manager source plus one selected-worker source.
export function ManagerSyncProvider(props: PropsWithChildren): JSX.Element {
    const { selected } = useAppScope();
    const selectedPort = selected?.port ?? null;
    const turnSubscribersRef = useRef(new Set<(payload: TurnLifecycleSsePayload) => void>());
    const bodySubscribersRef = useRef(new Set<(payload: AgentBodySsePayload) => void>());
    const systemSubscribersRef = useRef(new Set<(payload: SystemSsePayload) => void>());
    const queueSubscribersRef = useRef(new Set<(payload: QueueUpdateSsePayload) => void>());
    const invalidationSubscribersRef = useRef(new Set<(reason: SyncInvalidationReason) => void>());
    const cursorsRef = useRef(new Map<string, string>());
    const connectionsRef = useRef(new Map<string, SseConnection>());
    const previousPortRef = useRef<number | null | undefined>(undefined);

    const orcStateSubscribersRef = useRef(new Set<(payload: OrcStateSsePayload) => void>());
    const jwcSubscribersRef = useRef(new Set<(payload: JwcSsePayload) => void>());
    const managerWorkerSubscribersRef = useRef(new Set<(payload: ManagerWorkerSsePayload) => void>());

    const value = useMemo<ManagerSyncContextValue>(() => ({
        subscribeTurnLifecycle: (cb) => subscribe(turnSubscribersRef.current, cb),
        subscribeAgentBody: (cb) => subscribe(bodySubscribersRef.current, cb),
        subscribeQueueUpdate: (cb) => subscribe(queueSubscribersRef.current, cb),
        subscribeSystem: (cb) => subscribe(systemSubscribersRef.current, cb),
        subscribeInvalidation: (cb) => subscribe(invalidationSubscribersRef.current, cb),
        subscribeOrcState: (cb) => subscribe(orcStateSubscribersRef.current, cb),
        subscribeJwc: (cb) => subscribe(jwcSubscribersRef.current, cb),
        subscribeManagerWorker: (cb) => subscribe(managerWorkerSubscribersRef.current, cb),
    }), []);

    const createConnection = (key: string, url: string, source: 'manager' | 'worker'): SseConnection => {
        const connection = new SseConnection({
            key,
            url,
            createSource: createBrowserSseSource,
            getCursor: () => cursorsRef.current.get(key),
            setCursor: cursor => cursorsRef.current.set(key, cursor),
            onReconnect: () => publish(invalidationSubscribersRef.current, 'reconnect'),
            onPayload: (payload, eventId) => {
                if (payload['topic'] === 'system' && payload['event'] === 'ping') return;
                dispatchSyncPayloadForSource(source, payload, {
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
                    jwc: value => publish(jwcSubscribersRef.current, value),
                    managerWorker: value => publish(managerWorkerSubscribersRef.current, value),
                }, eventId);
            },
        });
        connection.setVisible(!document.hidden);
        connectionsRef.current.set(key, connection);
        connection.start();
        return connection;
    };

    useEffect(() => {
        const connection = createConnection('manager', '/api/events', 'manager');
        return () => {
            connection.stop();
            if (connectionsRef.current.get('manager') === connection) connectionsRef.current.delete('manager');
        };
    }, []);

    useEffect(() => {
        const previousPort = previousPortRef.current;
        previousPortRef.current = selectedPort;
        if (previousPort !== undefined && previousPort !== selectedPort) {
            publish(invalidationSubscribersRef.current, 'port_change');
        }
        if (selectedPort === null) return;
        const key = `worker:${selectedPort}`;
        const connection = createConnection(key, `/i/${selectedPort}/api/events`, 'worker');
        return () => {
            connection.stop();
            if (connectionsRef.current.get(key) === connection) connectionsRef.current.delete(key);
        };
    }, [selectedPort]);

    useEffect(() => {
        const onVisibilityChange = (): void => {
            for (const connection of connectionsRef.current.values()) {
                connection.setVisible(!document.hidden);
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, []);

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
