// ─── Worker SSE Client (manager → worker /api/events) ──
// P4-full of runtime SSE refactoring.
// The manager subscribes to each online worker's SSE stream instead of
// fetching messages on demand. Legacy workers without /api/events answer
// 4xx — those are marked unsupported ONCE and never retried (no backoff
// bombardment; 41's deferral concern). worker-events.ts owns lifecycle.

import { EventSource } from 'eventsource';

/** Wire shape of /api/events entries (data-only format, 00_1 F1):
 *  topic + event ride inside the JSON payload — no SSE `event:` field. */
export interface WorkerBusEvent {
    topic?: string;
    event?: string;
    [key: string]: unknown;
}

export interface WorkerEventHandlers {
    /** message:new_message — a new chat row landed on the worker. */
    onMessage?: (port: number, data: WorkerBusEvent) => void;
    /** agent:agent_done — the worker's agent finished a turn. */
    onAgentDone?: (port: number, data: WorkerBusEvent) => void;
    /** settings:settings_change — worker cli/model/projectDirs changed (#233). */
    onSettingsChange?: (port: number, data: WorkerBusEvent) => void;
    /** Worker answered 4xx (legacy server without /api/events). Permanent. */
    onUnsupported?: (port: number) => void;
    /** Connection gave up after exhausting transient retries. */
    onDisconnect?: (port: number) => void;
    /** Stream re-opened after an internal eventsource reconnect. Events
     *  emitted during the gap were never delivered (no lastEventId replay on
     *  this ping-style client) — consumers must re-sync derived state.
     * */
    onReopen?: (port: number) => void;
}

export const MAX_TRANSIENT_RETRIES = 10;

/** Injectable for tests — must match the EventSource constructor surface. */
export type EventSourceCtor = new (url: string) => Pick<
    EventSource, 'onmessage' | 'onerror' | 'onopen' | 'close' | 'readyState'
>;

export function subscribeToWorker(
    port: number,
    handlers: WorkerEventHandlers,
    EventSourceImpl: EventSourceCtor = EventSource,
): () => void {
    const es = new EventSourceImpl(`http://127.0.0.1:${port}/api/events`);
    let retryCount = 0;
    let done = false;
    let openedOnce = false;

    const finish = (notify: 'unsupported' | 'disconnect' | null) => {
        if (done) return;
        done = true;
        es.close();
        if (notify === 'unsupported') handlers.onUnsupported?.(port);
        if (notify === 'disconnect') handlers.onDisconnect?.(port);
    };

    es.onopen = () => {
        retryCount = 0;
        if (openedOnce) handlers.onReopen?.(port);
        openedOnce = true;
    };

    es.onmessage = (e) => {
        let data: WorkerBusEvent;
        try {
            data = JSON.parse(String(e.data)) as WorkerBusEvent;
        } catch {
            return; // malformed frame — ignore (P4-03 versioned schema policy)
        }
        const key = `${data.topic}:${data.event}`;
        if (key === 'message:new_message') handlers.onMessage?.(port, data);
        else if (key === 'agent:agent_done') handlers.onAgentDone?.(port, data);
        else if (key === 'settings:settings_change') handlers.onSettingsChange?.(port, data);
        // unknown topic:event ignored on purpose (forward compat)
    };

    es.onerror = (err: unknown) => {
        const code = (err as { code?: number })?.code;
        // eventsource@3 fails permanently on ANY non-2xx (readyState CLOSED
        // before onerror, no reconnect scheduled). Only route-shape statuses
        // mean "legacy worker without /api/events" — a 429 from the worker's
        // shared rate limiter (or 401/5xx) must NOT earn a permanent mark;
        // those end as 'disconnect' and get re-probed on the next status flap.
        if (code === 404 || code === 405 || code === 410 || code === 501) {
            finish('unsupported');
            return;
        }
        if (es.readyState === 2 /* CLOSED — no internal retry coming */) {
            finish('disconnect');
            return;
        }
        retryCount++;
        if (retryCount > MAX_TRANSIENT_RETRIES) finish('disconnect');
    };

    return () => finish(null);
}
