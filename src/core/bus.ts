// ─── Broadcast Bus (EventEmitter-style) ──────────────
// All modules import from here to avoid circular deps.

const broadcastListeners = new Set();
let wss = null;

export function setWss(w) { wss = w; }

export function addBroadcastListener(fn) { broadcastListeners.add(fn); }
export function removeBroadcastListener(fn) { broadcastListeners.delete(fn); }

export function broadcast(type, data) {
    const msg = JSON.stringify({ type, ...data, ts: Date.now() });
    if (wss) {
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    }
    for (const fn of broadcastListeners) fn(type, data);
}
