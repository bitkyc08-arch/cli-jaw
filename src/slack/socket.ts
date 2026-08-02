// ─── Slack Socket Mode Client ────────────────────────
// Protocol (docs.slack.dev/apis/events-api/using-socket-mode):
//   1. POST apps.connections.open with the app-level token -> wss:// URL
//   2. Connect; Slack sends {"type":"hello"} when it is ready
//   3. Each delivery is an envelope; reply {"envelope_id": "<id>"} within 3s
//   4. Slack recycles sockets every few hours and warns ~10s before closing
//
// Design rules this file enforces:
//   - ACK BEFORE WORK. Slack retries un-acked envelopes, so acking after the
//     agent run is how one message becomes three agent runs.
//   - Envelope-id dedupe. Retries carry the same envelope_id.
//   - Frames arriving while NOT connected are left UN-acked on purpose: that
//     is what makes Slack redeliver them on the new socket. Acking then
//     dropping would be permanent message loss.
//   - link_disabled is terminal, not transient: do not reconnect into a wall.

import { log } from '../core/logger.js';
import { slackApi, redactSlackTokens, type SlackFetch } from './api.js';

export type SlackConnectionState =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disabled';

export type SlackEnvelope = {
    envelope_id?: string;
    type: string;
    payload?: Record<string, unknown>;
    accepts_response_payload?: boolean;
    retry_attempt?: number;
    retry_reason?: string;
    reason?: string;
};

const HANDLED_ENVELOPE_TYPES = new Set(['events_api', 'slash_commands', 'interactive']);
const CONTROL_FRAME_TYPES = new Set(['hello', 'disconnect']);

/** How many recent envelope ids to remember for retry dedupe. */
const DEDUPE_WINDOW = 256;

/** Minimal socket surface used here — keeps the module testable without a real WebSocket. */
export type SlackSocketLike = {
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
};

export type SlackSocketOptions = {
    appToken: string;
    onEnvelope: (envelope: SlackEnvelope) => void | Promise<void>;
    fetchImpl?: SlackFetch;
    /** Injected for tests; defaults to the global WebSocket (Node 22+). */
    socketFactory?: (url: string) => SlackSocketLike;
    maxReconnectAttempts?: number;
    baseReconnectDelayMs?: number;
};

export class SlackSocketClient {
    private ws: SlackSocketLike | null = null;
    private state: SlackConnectionState = 'disconnected';
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private seenEnvelopeIds: string[] = [];
    private seenEnvelopeSet = new Set<string>();
    private stopped = false;
    private readonly maxReconnectAttempts: number;
    private readonly baseReconnectDelayMs: number;

    constructor(private readonly options: SlackSocketOptions) {
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
        this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1000;
    }

    getState(): SlackConnectionState { return this.state; }
    getReconnectAttempts(): number { return this.reconnectAttempts; }

    async start(): Promise<void> {
        this.stopped = false;
        await this.connect();
    }

    /**
     * Stop the client. `terminalState` preserves WHY it stopped so health and
     * diagnostics can distinguish "Socket Mode is off in app settings" from a
     * generic disconnect.
     */
    stop(terminalState: SlackConnectionState = 'disconnected'): void {
        this.stopped = true;
        this.clearReconnectTimer();
        this.state = terminalState;
        try { this.ws?.close(); } catch { /* already closing */ }
        this.ws = null;
    }

    private clearReconnectTimer(): void {
        // Clearing before scheduling prevents timer leaks on rapid disconnects.
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private defaultSocketFactory(url: string): SlackSocketLike {
        // Node 22+ ships a global WebSocket, which is why this transport needs
        // no SDK. See devlog/_plan/260802_slack_channel/000_plan.md D-1.
        const socket = new WebSocket(url);
        return {
            send: (data: string) => socket.send(data),
            close: () => socket.close(),
            addEventListener: (type: string, listener: (event: unknown) => void) =>
                socket.addEventListener(type, listener as EventListener),
        };
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;
        this.state = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';

        const opened = await slackApi<{ url?: string }>(
            this.options.appToken,
            'apps.connections.open',
            undefined,
            this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {},
        );
        const url = opened.data?.url;
        if (!opened.ok || !url) {
            log.warn('[slack:socket] apps.connections.open failed:', opened.error || 'no url');
            this.scheduleReconnect();
            return;
        }

        const factory = this.options.socketFactory ?? ((u: string) => this.defaultSocketFactory(u));
        const ws = factory(url);
        // A stopped client must not adopt a socket that opened while the
        // handshake was in flight.
        if (this.stopped) {
            try { ws.close(); } catch { /* already closing */ }
            return;
        }
        this.ws = ws;

        // Every listener below checks that IT still owns the live socket.
        // Slack recycles sockets, and a superseded socket's late `close` would
        // otherwise schedule an extra reconnect, compounding into a storm of
        // parallel connections.
        const isCurrent = () => this.ws === ws;

        ws.addEventListener('open', () => {
            if (!isCurrent()) return;
            // 'open' means the WS handshake finished, not that Slack accepted
            // us. Slack's readiness signal is the `hello` frame.
            log.info('[slack:socket] websocket open, awaiting hello');
        });
        ws.addEventListener('message', (event: unknown) => {
            if (!isCurrent()) return;
            const data = (event as { data?: unknown })?.data;
            void this.handleFrame(typeof data === 'string' ? data : String(data));
        });
        ws.addEventListener('error', (event: unknown) => {
            if (!isCurrent()) return;
            const message = (event as { message?: unknown })?.message;
            log.warn('[slack:socket] error', redactSlackTokens(String(message ?? 'socket error')));
        });
        ws.addEventListener('close', () => {
            if (!isCurrent() || this.stopped || this.state === 'disabled') return;
            // Detach so a repeated close from this same dead socket cannot
            // schedule a second reconnect.
            this.ws = null;
            log.info('[slack:socket] closed, scheduling reconnect');
            this.scheduleReconnect();
        });
    }

    private async handleFrame(raw: string): Promise<void> {
        let envelope: SlackEnvelope;
        try {
            envelope = JSON.parse(raw) as SlackEnvelope;
        } catch {
            log.warn('[slack:socket] unparseable frame dropped');
            return;
        }
        if (!envelope || typeof envelope.type !== 'string') return;

        if (CONTROL_FRAME_TYPES.has(envelope.type)) {
            if (envelope.type === 'hello') {
                this.state = 'connected';
                this.reconnectAttempts = 0;
                log.info('[slack:socket] hello received, connected');
                return;
            }
            // 'link_disabled' means Socket Mode was turned off in app settings.
            // Reconnecting would burn attempts against a closed door.
            if (envelope.reason === 'link_disabled') {
                log.warn('[slack:socket] link_disabled — Socket Mode is off in app settings');
                this.stop('disabled');
                return;
            }
            log.info(`[slack:socket] disconnect (${envelope.reason || 'unspecified'}), reconnecting`);
            this.scheduleReconnect();
            return;
        }

        if (!HANDLED_ENVELOPE_TYPES.has(envelope.type)) return;

        // Reconnect-window guard — BEFORE the ack. Leaving the envelope
        // un-acked is what makes Slack redeliver it on the new connection.
        if (this.state !== 'connected') {
            log.info(`[slack:socket] frame left un-acked while state=${this.state} (Slack will redeliver)`);
            return;
        }

        // ACK FIRST — before any work, always within the 3s deadline.
        if (envelope.envelope_id) {
            this.ack(envelope.envelope_id);
            if (this.isDuplicate(envelope.envelope_id)) {
                log.info(`[slack:socket] duplicate envelope ignored (retry_attempt=${envelope.retry_attempt ?? 0})`);
                return;
            }
        }

        try {
            await this.options.onEnvelope(envelope);
        } catch (error) {
            log.error('[slack:socket] handler error', redactSlackTokens((error as Error).message));
        }
    }

    private ack(envelopeId: string): void {
        try {
            this.ws?.send(JSON.stringify({ envelope_id: envelopeId }));
        } catch (error) {
            log.warn('[slack:socket] ack failed', (error as Error).message);
        }
    }

    private isDuplicate(envelopeId: string): boolean {
        if (this.seenEnvelopeSet.has(envelopeId)) return true;
        this.seenEnvelopeSet.add(envelopeId);
        this.seenEnvelopeIds.push(envelopeId);
        if (this.seenEnvelopeIds.length > DEDUPE_WINDOW) {
            const evicted = this.seenEnvelopeIds.shift();
            if (evicted) this.seenEnvelopeSet.delete(evicted);
        }
        return false;
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.state === 'disabled') return;
        // An already-pending reconnect wins; a second trigger (e.g. a
        // `disconnect` frame immediately followed by `close`) must not stack.
        if (this.reconnectTimer) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.error(`[slack:socket] max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up`);
            this.state = 'disconnected';
            return;
        }
        this.clearReconnectTimer();
        const delay = Math.min(this.baseReconnectDelayMs * 2 ** this.reconnectAttempts, 60000);
        this.reconnectAttempts++;
        this.state = 'reconnecting';
        log.info(`[slack:socket] reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }
}
