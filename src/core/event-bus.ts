// ─── Topic-based Event Bus (SSE backbone) ────────────
// Phase 1 of runtime SSE refactoring (devlog 260609, 10_phase1).
// Standalone by design: imports node:events only — no project deps, no cycles.
// bus.ts dual-emits into this bus; routes/events.ts streams it out as SSE.

import { EventEmitter } from 'node:events';

export const RING_SIZE = 1000;
export const MAX_SSE_LISTENERS = 256;

export type EventTopic =
    | 'agent'       // agent_done, agent_output, agent_tool, agent_status, steer_started
    | 'orchestrate' // orc_state, orchestrate_done
    | 'goal'        // goal_done, goal_cancel, goal_continuation*
    | 'workflow'    // (reserved — no active emitter yet)
    | 'memory'      // memory_status
    | 'worker'      // worker_stalled/disconnected/timeout
    | 'message'     // new_message
    | 'queue'       // queue_update
    | 'bgtask'      // bgtask_update
    | 'heartbeat'   // heartbeat_pending
    | 'schedule'    // schedule_wakeup, schedule_wakeup_failed
    | 'session'     // clear, session_reset/switched/created/list
    | 'settings'    // settings_change
    | 'agents'      // agent_added, agent_updated, agent_deleted
    | 'widget'      // widget_updated
    | 'trace'       // internal-only (agent:claude-e:*) — never SSE-public
    | 'jwc'         // Code mode: jwc engine session updates (code_* events, acp-host)
    | 'system';     // system_notice, alert_escalation, fallback bucket

// Public SSE topic allowlist — the single source of truth for which bus topics
// may be serialized out through public SSE routes. `trace` is internal-only
// (agent:claude-e:* diagnostics) and must NEVER reach a browser. Enforcing this
// at the route boundary (not just by publisher convention) closes the leak even
// if a future publisher emits `trace` by mistake (260628 phase 10 SSE safety).
export const PUBLIC_SSE_TOPICS: ReadonlySet<EventTopic> = new Set<EventTopic>([
    'agent', 'orchestrate', 'goal', 'workflow', 'memory', 'worker',
    'message', 'queue', 'bgtask', 'heartbeat', 'schedule', 'session',
    'settings', 'agents', 'widget', 'jwc', 'system',
]);

export function isPublicSseTopic(topic: EventTopic): boolean {
    return PUBLIC_SSE_TOPICS.has(topic);
}

export interface BusEvent {
    id: number;
    topic: EventTopic;
    event: string;
    data: Record<string, unknown>;
    ts: number;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(MAX_SSE_LISTENERS);

let seq = 0;
const ring: BusEvent[] = [];

export function publish(topic: EventTopic, event: string, data: Record<string, unknown>): void {
    const entry: BusEvent = { id: ++seq, topic, event, data, ts: Date.now() };
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
    emitter.emit('event', entry);
}

export function subscribe(listener: (entry: BusEvent) => void): () => void {
    // Wrap so one faulty listener cannot break publish() callers (broadcast path).
    const safe = (entry: BusEvent) => {
        try {
            listener(entry);
        } catch (e) {
            console.warn('[event-bus] listener error:', (e as Error).message);
        }
    };
    emitter.on('event', safe);
    return () => { emitter.off('event', safe); };
}

export function replaySince(lastId: number): BusEvent[] {
    const idx = ring.findIndex(e => e.id > lastId);
    return idx >= 0 ? ring.slice(idx) : [];
}

export function hasReplayGap(lastId: number): boolean {
    return lastId > 0 && ring.length > 0 && ring[0]!.id > lastId + 1;
}

export function currentSeq(): number { return seq; }
