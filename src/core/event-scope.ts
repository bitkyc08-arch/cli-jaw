// ─── Scoped SSE delivery rule (072 §1.3a) ────────────
// A browser tab bound to one chat session connects with `?scope=`, and the route
// filters on strict equality against `data.scope`. That filter alone is not enough,
// because `broadcast()` stamps the ambient session scope onto EVERY event published
// inside a session's async context (core/bus.ts). Instance-wide events published
// during an agent turn — a heartbeat, a settings reload — therefore carry that
// session's scope and would vanish from every other tab.
//
// So delivery asks two questions in order: is this event instance-wide (deliver to
// everyone regardless of the scope it happens to carry), and otherwise does its scope
// match the connection. The judgement is "does one session own this event", not "is it
// topology". An event wrongly marked instance-wide is just noise in a tab; an event
// wrongly marked session-owned disappears.

import type { BusEvent } from './event-bus.js';

// Instance-wide events. Every tab needs these regardless of which session's async
// context happened to publish them.
export const INSTANCE_WIDE_EVENTS: ReadonlySet<string> = new Set<string>([
    // The session list itself — a tab must see sessions appear and disappear.
    'session_created',
    'session_list',
    // Instance configuration and inventory.
    'settings_change',
    'agent_added',
    'agent_updated',
    'agent_deleted',
    // Instance-wide subsystems with no session dimension.
    'memory_status',
    'heartbeat_pending',
    'bgtask_update',
    'alert_escalation',
    'system_notice',
    'schedule_wakeup',
    'schedule_wakeup_failed',
]);

// Goal state is a single instance-wide file with no session field (goal/store.ts).
// A goal finished in one tab must clear the cockpit in every tab, so goal events are
// delivered everywhere even though a turn in one session produced them.
export function isInstanceWideEvent(event: string): boolean {
    return INSTANCE_WIDE_EVENTS.has(event) || event.startsWith('goal_');
}

export function shouldDeliverToScope(entry: BusEvent, scopeFilter: string | undefined): boolean {
    // No filter means "everything", which is what manager and worker connections rely on.
    if (!scopeFilter) return true;
    if (isInstanceWideEvent(entry.event)) return true;
    return entry.data["scope"] === scopeFilter;
}
