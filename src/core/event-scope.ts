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
import { DELIVERY_KEY_GLOBAL, DELIVERY_KEY_NONE, isPublicSseTopic } from './event-bus.js';

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
    'schedule_wakeup',
    'schedule_wakeup_failed',
    // A global switch is published outside any session context, so it carries no scope
    // and a strict filter would drop it from every scoped tab — leaving each of them
    // showing a stale idea of which session is active.
    'session_switched',
]);

// `system_notice` is a mixed bag: some notices describe one session's turn and some
// describe the instance. Classifying the whole type either way is wrong, so the code
// decides. An unrecognised code is treated as instance-wide, which is the safe error:
// an extra notice is noise, a missing one is invisible.
//
// The code is not sufficient on its own. `auto_compact_refresh` is published both by a
// session's own turn AND by the instance-wide reset in session-ops, and only the first
// carries a scope. A notice with no scope has no session to belong to, so it is
// delivered everywhere rather than nowhere.
const SESSION_OWNED_NOTICE_CODES: ReadonlySet<string> = new Set<string>([
    'compact_suggest',
    'auto_compact_refresh',
]);

function isSessionOwnedNotice(data: Record<string, unknown>): boolean {
    const code = data["code"];
    return typeof code === 'string'
        && SESSION_OWNED_NOTICE_CODES.has(code)
        && typeof data["scope"] === 'string';
}

// Goal state is a single instance-wide file with no session field (goal/store.ts).
// A goal finished in one tab must clear the cockpit in every tab, so goal events are
// delivered everywhere even though a turn in one session produced them.
export function isInstanceWideEvent(event: string): boolean {
    return INSTANCE_WIDE_EVENTS.has(event) || event.startsWith('goal_');
}

export function shouldDeliverToScope(entry: BusEvent, scopeFilter: string | undefined): boolean {
    // No filter means "everything", which is what manager and worker connections rely on.
    if (!scopeFilter) return true;
    if (entry.event === 'system_notice') {
        return isSessionOwnedNotice(entry.data)
            ? entry.data["scope"] === scopeFilter
            : true;
    }
    if (isInstanceWideEvent(entry.event)) return true;
    return entry.data["scope"] === scopeFilter;
}

/**
 * The delivery class of an event, for the replay-gap watermarks in the bus.
 *
 * It answers the same questions as delivery, in the same order, because a gap check that
 * classified events differently from the filter would report losses that never happened
 * and miss ones that did. The route drops non-public topics before it looks at scope, so
 * that comes first here too: an event no subscriber can see costs nobody anything when it
 * ages out.
 */
export function deliveryKeyForEntry(entry: BusEvent): string {
    if (!isPublicSseTopic(entry.topic)) return DELIVERY_KEY_NONE;
    if (entry.event === 'system_notice') {
        // A compact suggestion belongs to the session that raised it; every other notice
        // is for the whole instance.
        return isSessionOwnedNotice(entry.data)
            ? String(entry.data["scope"])
            : DELIVERY_KEY_GLOBAL;
    }
    if (isInstanceWideEvent(entry.event)) return DELIVERY_KEY_GLOBAL;
    const scope = entry.data["scope"];
    return typeof scope === 'string' && scope ? scope : DELIVERY_KEY_GLOBAL;
}
