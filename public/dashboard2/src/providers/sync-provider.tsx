import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    type JSX,
    type PropsWithChildren,
} from 'react';
import type { TurnLifecycleSsePayload } from '../../../../src/shared/chat-events.ts';
import { useAppScope } from '../state/scope.tsx';

export interface SystemSsePayload {
    topic: 'system';
    event: 'replay_gap' | 'turn_segment_error';
    sseReplay?: boolean;
    [key: string]: unknown;
}

export type SyncInvalidationReason = 'replay_gap' | 'reconnect' | 'port_change';

export interface ManagerSyncContextValue {
    subscribeTurnLifecycle(cb: (payload: TurnLifecycleSsePayload) => void): () => void;
    subscribeSystem(cb: (payload: SystemSsePayload) => void): () => void;
    subscribeInvalidation(cb: (reason: SyncInvalidationReason) => void): () => void;
}

type SseEnvelope = {
    topic?: unknown;
    event?: unknown;
    [key: string]: unknown;
};

const TURN_LIFECYCLE_EVENTS = new Set(['turn_start', 'turn_segment', 'turn_end']);
const SYSTEM_EVENTS = new Set(['replay_gap', 'turn_segment_error']);
const ManagerSyncContext = createContext<ManagerSyncContextValue | null>(null);

function subscribe<T>(subscribers: Set<(value: T) => void>, cb: (value: T) => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
}

function publish<T>(subscribers: Set<(value: T) => void>, value: T): void {
    for (const subscriber of subscribers) subscriber(value);
}

// Mounted once per app root so one selected instance owns one EventSource.
export function ManagerSyncProvider(props: PropsWithChildren): JSX.Element {
    const { selected } = useAppScope();
    const selectedPort = selected?.port ?? null;
    const turnSubscribersRef = useRef(new Set<(payload: TurnLifecycleSsePayload) => void>());
    const systemSubscribersRef = useRef(new Set<(payload: SystemSsePayload) => void>());
    const invalidationSubscribersRef = useRef(new Set<(reason: SyncInvalidationReason) => void>());
    const generationRef = useRef(0);
    const lastEventIdByPortRef = useRef(new Map<number, string>());
    const previousPortRef = useRef<number | null | undefined>(undefined);

    const value = useMemo<ManagerSyncContextValue>(() => ({
        subscribeTurnLifecycle: (cb) => subscribe(turnSubscribersRef.current, cb),
        subscribeSystem: (cb) => subscribe(systemSubscribersRef.current, cb),
        subscribeInvalidation: (cb) => subscribe(invalidationSubscribersRef.current, cb),
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

                if (payload.topic === 'agent'
                    && typeof payload.event === 'string'
                    && TURN_LIFECYCLE_EVENTS.has(payload.event)) {
                    publish(turnSubscribersRef.current, payload as unknown as TurnLifecycleSsePayload);
                    return;
                }
                if (payload.topic === 'system'
                    && typeof payload.event === 'string'
                    && SYSTEM_EVENTS.has(payload.event)) {
                    const systemPayload = payload as SystemSsePayload;
                    publish(systemSubscribersRef.current, systemPayload);
                    if (systemPayload.event === 'replay_gap') {
                        publish(invalidationSubscribersRef.current, 'replay_gap');
                    }
                }
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
