// ─── Topic-based Event Bus (SSE backbone) ────────────
// Phase 1 of runtime SSE refactoring.
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
    | 'code'        // Native Code sessions; persisted per-session sequence and item updates
    | 'system';     // system_notice, alert_escalation, fallback bucket

// Public SSE topic allowlist — the single source of truth for which bus topics
// may be serialized out through public SSE routes. `trace` is internal-only
// (agent:claude-e:* diagnostics) and must NEVER reach a browser. Enforcing this
// at the route boundary (not just by publisher convention) closes the leak even
// if a future publisher emits `trace` by mistake (260628 phase 10 SSE safety).
export const PUBLIC_SSE_TOPICS: ReadonlySet<EventTopic> = new Set<EventTopic>([
    'agent', 'orchestrate', 'goal', 'workflow', 'memory', 'worker',
    'message', 'queue', 'bgtask', 'heartbeat', 'schedule', 'session',
    'settings', 'agents', 'widget', 'jwc', 'code', 'system',
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

// Which connections an event reaches, decided the same way delivery decides it. The ring
// is one buffer for every scope, so the oldest surviving id says nothing about whether a
// particular subscriber missed something: the ids in between belong to other scopes. What
// does say something is what fell out — so evictions are recorded per delivery class and
// gaps are declared from that alone.
export const DELIVERY_KEY_NONE = '';
export const DELIVERY_KEY_GLOBAL = '*';
/** Every eviction that reached anyone, for subscribers that take the whole stream. */
const DELIVERY_KEY_ALL = '**';

/**
 * Returns the delivery class of an entry: NONE for anything no subscriber sees, GLOBAL for
 * what reaches every scope, otherwise the scope it belongs to.
 *
 * Injected because that decision lives with the delivery rules and this module holds no
 * project dependencies. Left unset it calls everything GLOBAL, which over-reports gaps
 * rather than missing them.
 */
export type DeliveryKeyResolver = (entry: BusEvent) => string;
let deliveryKeyOf: DeliveryKeyResolver = () => DELIVERY_KEY_GLOBAL;

export function setDeliveryKeyResolver(resolver: DeliveryKeyResolver): void {
    deliveryKeyOf = resolver;
}

// Highest evicted id per delivery class. Never pruned: an entry costs a key and an
// integer, while dropping one means a tab that reconnects with an old cursor is told it
// missed nothing. Keys follow sessions, which users create at human pace.
const evictedMaxId = new Map<string, number>();

function recordEviction(entry: BusEvent): void {
    const key = deliveryKeyOf(entry);
    if (key === DELIVERY_KEY_NONE) return;
    evictedMaxId.set(DELIVERY_KEY_ALL, entry.id);
    evictedMaxId.set(key, entry.id);
}

export function publish(topic: EventTopic, event: string, data: Record<string, unknown>): void {
    const entry: BusEvent = { id: ++seq, topic, event, data, ts: Date.now() };
    ring.push(entry);
    if (ring.length > RING_SIZE) {
        const evicted = ring.shift();
        if (evicted) recordEviction(evicted);
    }
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

/**
 * True when something this connection would have received has already left the ring.
 *
 * Only evictions are evidence. Comparing against the oldest surviving entry would raise a
 * gap on a quiet scope every time a busy one filled the buffer, which is the false alarm
 * this replaces.
 */
export function hasReplayGap(lastId: number, scopeFilter?: string): boolean {
    if (lastId <= 0) return false;
    // No filter means the whole stream, so any eviction that reached anyone is a loss.
    if (!scopeFilter) return (evictedMaxId.get(DELIVERY_KEY_ALL) ?? 0) > lastId;
    if ((evictedMaxId.get(DELIVERY_KEY_GLOBAL) ?? 0) > lastId) return true;
    return (evictedMaxId.get(scopeFilter) ?? 0) > lastId;
}

/** Live count of tracked delivery classes, exposed so the growth can be watched. */
export function deliveryWatermarkCount(): number {
    return evictedMaxId.size;
}

export function currentSeq(): number { return seq; }
