// ─── Broadcast Bus (EventEmitter-style) ──────────────
// All modules import from here to avoid circular deps.

import { sanitizeToolLogEntry, sanitizeToolLogForDurableStorage } from '../shared/tool-log-sanitize.js';
import { publish as ssePublish, type EventTopic } from './event-bus.js';
import { settings } from './config.js';
import { currentSessionScope } from './session-context.js';

export type BroadcastListener = (type: string, data: Record<string, any>) => void;
type BroadcastPayload = Parameters<BroadcastListener>[1];

const broadcastListeners = new Set<BroadcastListener>();

export function addBroadcastListener(fn: BroadcastListener) { broadcastListeners.add(fn); }
export function removeBroadcastListener(fn: BroadcastListener) { broadcastListeners.delete(fn); }
export function clearAllBroadcastListeners() { broadcastListeners.clear(); }

function sanitizeBroadcastData(type: string, data: BroadcastPayload): BroadcastPayload {
    if (type === 'agent_tool') {
        return { ...data, ...sanitizeToolLogEntry(data) };
    }
    if (type === 'agent_done' && Array.isArray(data["toolLog"])) {
        return { ...data, toolLog: sanitizeToolLogForDurableStorage(data["toolLog"]) };
    }
    return data;
}

// Topic inference for the SSE emit. The trace branch must stay first:
// internal claude-e runtime events must never route to the public 'agent'
// topic (devlog 260609 00_1 F2). agents CRUD precedes the generic agent_ prefix.
export function inferTopic(type: string): EventTopic {
    if (type.startsWith('agent:claude-e:')) return 'trace';
    if (type === 'agent_added' || type === 'agent_updated' || type === 'agent_deleted') return 'agents';
    // `steer_*` events are named after the action, not the subsystem, so the
    // `agent_` prefix above does not catch them and each has to be listed. Both
    // topics reach a subscribed client today (the browser dispatches on type,
    // not topic), so this is taxonomy rather than delivery — but a steer event
    // filed under `system` is a lie about what it describes (#523).
    if (type.startsWith('agent_') || type.startsWith('agent:') || type.startsWith('steer_')) return 'agent';
    if (type.startsWith('orc_') || type.startsWith('orchestrate_')
        || type === 'worklog_created' || type === 'round_start' || type === 'round_done') return 'orchestrate';
    if (type.startsWith('goal_')) return 'goal';
    if (type === 'workflow_event') return 'workflow';
    if (type.startsWith('memory_')) return 'memory';
    if (type.startsWith('worker_')) return 'worker';
    if (type === 'new_message') return 'message';
    if (type === 'queue_update') return 'queue';
    if (type === 'bgtask_update') return 'bgtask';
    if (type === 'heartbeat_pending') return 'heartbeat';
    if (type.startsWith('schedule_')) return 'schedule';
    if (type === 'clear' || type.startsWith('session_')) return 'session';
    if (type === 'settings_change') return 'settings';
    if (type === 'widget_updated') return 'widget';
    return 'system';
}

export function broadcast(type: string, data: Record<string, any>, audience: 'public' | 'internal' = 'public') {
    // Semantic presentation is never input to collectors, forwarders or ACK owners.
    // Its producer supplies captured identity, even when multi-session is disabled.
    if (type === 'agent_runtime' || type === 'agent_runtime_gap') {
        if (audience === 'public') ssePublish('agent', type, data);
        return;
    }
    const captured = currentSessionScope();
    const scopedData = captured && settings["multiSession"]?.enabled === true
        ? { ...data, scope: data["scope"] ?? captured.scope, sessionId: data["sessionId"] ?? captured.chatSessionId }
        : data;
    const safeData = sanitizeBroadcastData(type, scopedData);
    // Public events reach browsers only via the SSE event-bus (X-01: the legacy
    // WS broadcast path is removed) — public only (P1-09 audience gate),
    // sanitized payload only (P1-08). Internal listeners always receive.
    if (audience === 'public') {
        ssePublish(inferTopic(type), type, safeData);
    }
    for (const fn of broadcastListeners) fn(type, safeData);
}
