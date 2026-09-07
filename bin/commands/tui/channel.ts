/**
 * Chat transport channel — SSE-first with legacy-WS fallback (X-01,
 * devlog 260609, 50). New servers have no WebSocket channel; old servers
 * have no /api/events — the adapter connects to whichever answers and
 * exposes the WebSocket subset the TUI already uses (send/on/close), so
 * every call site stays transport-agnostic:
 *   - inbound SSE frames {…data, topic, event} are re-encoded to the
 *     legacy wire {type, …data} before reaching handlers
 *   - outbound send_message/stop become POST /api/message · /api/stop
 */
import WebSocket from 'ws';
import { EventSource } from 'eventsource';
import { getServerUrl, getWsUrl } from '../../../src/core/config.js';
import { authHeaders, getCliAuthToken } from '../../../src/cli/api-auth.js';

export type ChannelData = string | Buffer;

export interface ChatChannel {
    readonly transport: 'sse' | 'ws';
    /** Accepts the legacy JSON wire: {type:'send_message',text} | {type:'stop'} */
    send(payload: string): void;
    on(event: 'message', cb: (data: ChannelData) => void): void;
    on(event: 'close', cb: () => void): void;
    onReconnect?(cb: () => void): void;
    close(): void;
}

async function connectSse(port: string | number): Promise<ChatChannel> {
    const apiUrl = getServerUrl(port);
    // Prime the token cache before the EventSource opens — connectChannel runs
    // before any other API call at TUI startup, and authHeaders() reads the
    // cache synchronously. Loopback needs no token; failures resolve to ''.
    await getCliAuthToken(apiUrl);
    return new Promise((resolve, reject) => {
        // Custom fetch injects the CLI auth token — EventSource cannot set
        // headers natively, and GET /api/events sits behind requireAuth for
        // non-loopback clients.
        const es = new EventSource(`${apiUrl}/api/events`, {
            fetch: (input, init) => fetch(input, {
                ...init,
                headers: { ...(init?.headers as Record<string, string> | undefined), ...authHeaders() },
            }),
        });
        const messageCbs: Array<(data: ChannelData) => void> = [];
        const closeCbs: Array<() => void> = [];
        const reconnectCbs: Array<() => void> = [];
        let opened = false;
        let closed = false;

        const emitClose = () => {
            if (closed) return;
            closed = true;
            es.close();
            for (const cb of closeCbs) cb();
            messageCbs.length = 0;
            closeCbs.length = 0;
            reconnectCbs.length = 0;
        };

        es.onopen = () => {
            if (closed) return;
            if (opened) { for (const cb of reconnectCbs) cb(); return; }
            opened = true;
            resolve(channel);
        };

        es.onerror = (err) => {
            if (!opened) {
                es.close();
                reject(err instanceof Error ? err : new Error('sse_unavailable'));
                return;
            }
            // Post-open transient drops auto-reconnect inside the library
            // (Last-Event-ID replay included). CLOSED means it gave up —
            // treat like the old WS close so the TUI exits cleanly.
            if (es.readyState === 2) emitClose();
        };

        es.onmessage = (e) => {
            try {
                const { topic: _topic, event, ...rest } = JSON.parse(String(e.data)) as Record<string, unknown> & { topic?: string; event?: string };
                const wire = JSON.stringify({ type: event, ...rest });
                for (const cb of messageCbs) cb(wire);
            } catch { /* malformed frame — ignore */ }
        };

        const channel: ChatChannel = {
            transport: 'sse',
            send(payload: string) {
                let msg: { type?: string; text?: unknown };
                try { msg = JSON.parse(payload) as { type?: string; text?: unknown }; } catch { return; }
                // authHeaders() is evaluated per-send: the token cache is
                // filled by getCliAuthToken during TUI startup (refreshInfo),
                // so non-loopback connections stop silently 401ing here.
                if (msg.type === 'send_message' && typeof msg.text === 'string' && msg.text.trim()) {
                    void fetch(`${apiUrl}/api/message`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ prompt: msg.text }),
                    }).catch(() => { /* server reports failures via agent_done events */ });
                } else if (msg.type === 'stop') {
                    void fetch(`${apiUrl}/api/stop`, { method: 'POST', headers: authHeaders() }).catch(() => { });
                }
            },
            on(event: 'message' | 'close', cb: ((data: ChannelData) => void) | (() => void)) {
                if (event === 'message') messageCbs.push(cb as (data: ChannelData) => void);
                else closeCbs.push(cb as () => void);
            },
            onReconnect(cb) { reconnectCbs.push(cb); },
            close: emitClose,
        };
    });
}

function connectLegacyWs(port: string | number): Promise<ChatChannel> {
    return new Promise((resolve, reject) => {
        const s = new WebSocket(getWsUrl(port));
        s.on('open', () => resolve({
            transport: 'ws',
            send(payload: string) { try { s.send(payload); } catch { /* socket closing */ } },
            on(event: 'message' | 'close', cb: ((data: ChannelData) => void) | (() => void)) {
                s.on(event, cb as () => void);
            },
            close() { try { s.close(); } catch { /* already closed */ } },
        }));
        s.on('error', reject);
    });
}

/** SSE first (new servers), legacy WS second (old servers).
 *  Rejects only when both transports fail (server not running). */
export async function connectChannel(port: string | number): Promise<ChatChannel> {
    try {
        return await connectSse(port);
    } catch {
        return await connectLegacyWs(port);
    }
}
