// ─── Broadcast Bus (EventEmitter-style) ──────────────
// All modules import from here to avoid circular deps.

import type { WebSocketServer, WebSocket } from 'ws';
import { sanitizeToolLogEntry, sanitizeToolLogForDurableStorage } from '../shared/tool-log-sanitize.js';

export type BroadcastListener = (type: string, data: Record<string, any>) => void;
type BroadcastPayload = Parameters<BroadcastListener>[1];

const broadcastListeners = new Set<BroadcastListener>();
let wss: WebSocketServer | null = null;

export function setWss(w: WebSocketServer | null) { wss = w; }

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

export function broadcast(type: string, data: Record<string, any>, audience: 'public' | 'internal' = 'public') {
    const safeData = sanitizeBroadcastData(type, data);
    const msg = JSON.stringify({ type, ...safeData, ts: Date.now() });
    if (audience === 'public' && wss) {
        wss.clients.forEach((c: WebSocket) => { if (c.readyState === 1) c.send(msg); });
    }
    for (const fn of broadcastListeners) fn(type, safeData);
}
