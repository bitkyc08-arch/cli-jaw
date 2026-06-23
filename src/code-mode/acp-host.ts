// Resident ACP host: single long-lived `jwc --mode acp` child serving N sessions.
// Lifecycle pattern follows src/browser/connection.ts (singleton child + idle reaper + respawn).
// Protocol: ACP = JSON-RPC 2.0 over NDJSON stdio. Implemented with a minimal inline
// client (no new dependency); swapping to @agentclientprotocol/sdk is a drop-in later
// since the surface below mirrors ClientSideConnection method names.
// Design SoT: jawcode devlog 112.3 §S1 (C2) / handshake facts from acp-agent.ts 실사.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publish } from '../core/event-bus.js';
import { loadSettings } from '../core/config.js';
import { DEFAULT_CODE_SETTINGS, type CodeSessionInfo, type CodeSessionReplayEvent, type CodeSessionTransport, type PendingPermission, type PromptAccepted, type StoredCodeSessionInfo } from './types.js';

const PROTOCOL_VERSION = 1;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

interface JsonRpcMessage {
    jsonrpc: '2.0';
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: Record<string, unknown> };
}

interface Deferred {
    resolve: (value: Record<string, unknown>) => void;
    reject: (err: Error) => void;
}

function resolveAcpCommand(): { cmd: string; args: string[]; binDir?: string } {
    // Override for dev checkouts, e.g. JWC_ACP_CMD="bun /path/jawcode/packages/jwc/bin/jwc.js --mode acp"
    const override = process.env['JWC_ACP_CMD'];
    if (override && override.trim()) {
        const parts = override.trim().split(/\s+/);
        const cmd = parts[0];
        if (cmd) return { cmd, args: parts.slice(1) };
    }
    const candidates = [
        // Electron packaged sidecar: .../server/dist/src/code-mode/acp-host.js -> .../server/bin/jwc
        join(MODULE_DIR, '..', '..', '..', 'bin', 'jwc'),
        // Source/tsx mode: .../src/code-mode/acp-host.ts -> repo/bin/jwc
        join(MODULE_DIR, '..', '..', 'bin', 'jwc'),
        // Electron/local-dev runtime: prefer an explicitly bundled or locally installed jawcode .bin before any stale global jwc shim. Plain npm installs do not include jawcode by default.
        join(MODULE_DIR, '..', '..', '..', 'node_modules', '.bin', 'jwc'),
        join(MODULE_DIR, '..', '..', 'node_modules', '.bin', 'jwc'),
        join(process.cwd(), 'node_modules', '.bin', 'jwc'),
        // CLI/server launched from repo root.
        join(process.cwd(), 'bin', 'jwc'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return { cmd: candidate, args: ['--mode', 'acp'], binDir: dirname(candidate) };
    }
    return { cmd: 'jwc', args: ['--mode', 'acp'] };
}

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeStoredSession(raw: Record<string, unknown>): StoredCodeSessionInfo {
    const meta = objectField(raw['_meta']);
    const updatedAt = stringField(raw['updatedAt']) ?? stringField(raw['modified']);
    const parsedUpdatedAt = updatedAt ? Date.parse(updatedAt) : NaN;
    const lastModified = numberField(raw['lastModified']) ?? (Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : undefined);
    const entry: StoredCodeSessionInfo = {
        sessionId: String(raw['sessionId'] ?? raw['id'] ?? ''),
        cwd: String(raw['cwd'] ?? ''),
    };
    const title = stringField(raw['title']);
    const firstMessage = stringField(raw['firstMessage']);
    const messageCount = numberField(raw['messageCount']) ?? numberField(meta['messageCount']);
    const size = numberField(raw['size']) ?? numberField(meta['size']);
    if (title) entry.title = title;
    if (firstMessage) entry.firstMessage = firstMessage;
    if (updatedAt) entry.updatedAt = updatedAt;
    if (lastModified !== undefined) entry.lastModified = lastModified;
    if (messageCount !== undefined) entry.messageCount = messageCount;
    if (size !== undefined) entry.size = size;
    return entry;
}

class AcpHost implements CodeSessionTransport {
    #child: ChildProcess | null = null;
    #nextId = 1;
    #pendingRpc = new Map<number | string, Deferred>();
    #sessions = new Map<string, CodeSessionInfo>();
    #permissions = new Map<string, PendingPermission & { respond: (result: Record<string, unknown>) => void }>();
    #replayCaptures = new Map<string, Set<CodeSessionReplayEvent[]>>();
    #initialized: Promise<void> | null = null;
    #idleReaper: ReturnType<typeof setInterval> | null = null;

    // ── child lifecycle ───────────────────────────────────────────────
    async #ensureChild(): Promise<void> {
        if (this.#child && this.#child.exitCode === null && this.#initialized) return this.#initialized;
        const { cmd, args, binDir } = resolveAcpCommand();
        const child = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'inherit'],
            env: {
                ...process.env,
                JWC_BRAND_NAME: 'jwc',
                PATH: binDir ? `${binDir}:${process.env['PATH'] ?? ''}` : process.env['PATH'],
            },
        });
        this.#child = child;
        const rl = createInterface({ input: child.stdout! });
        rl.on('line', line => this.#onLine(line));
        child.on('exit', code => this.#onChildExit(code));
        // On handshake failure, reset #initialized so the NEXT call respawns instead
        // of returning the same rejected promise forever (no auto-recovery otherwise).
        this.#initialized = this.#handshake().catch(err => {
            this.#initialized = null;
            try { this.#child?.kill('SIGTERM'); } catch { /* ignore */ }
            this.#child = null;
            throw err;
        });
        this.#startIdleReaper();
        return this.#initialized;
    }

    async #handshake(): Promise<void> {
        // initialize → authenticate (method "agent" reuses ~/.jwc credentials).
        await this.#request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        await this.#request('authenticate', { methodId: 'agent' }).catch(() => {
            // Some engine builds skip auth when credentials already exist — non-fatal.
        });
    }

    #onChildExit(code: number | null): void {
        for (const [, d] of this.#pendingRpc) d.reject(new Error(`acp child exited (code ${code})`));
        this.#pendingRpc.clear();
        for (const s of this.#sessions.values()) s.status = 'closed';
        this.#permissions.clear();
        this.#child = null;
        this.#initialized = null;
        publish('jwc', 'code_child_exit', { code });
        // Lazy respawn: next newSession()/prompt() re-runs #ensureChild().
        // TODO(S3): auto loadSession replay for sessions that were live (B4 recovery).
    }

    #startIdleReaper(): void {
        if (this.#idleReaper) return;
        const settings = loadSettings();
        const idleReapMs = Number((settings['code'] as Record<string, unknown> | undefined)?.['idleReapMs'] ?? DEFAULT_CODE_SETTINGS.idleReapMs);
        this.#idleReaper = setInterval(() => {
            if (!this.#child) return;
            const live = [...this.#sessions.values()].filter(s => s.status !== 'closed');
            const newest = Math.max(0, ...live.map(s => s.lastUsedAt));
            if (live.length === 0 && Date.now() - newest > idleReapMs) {
                this.#child.kill('SIGTERM');
            }
        }, idleReapMs);
        this.#idleReaper.unref();
    }

    // ── JSON-RPC plumbing ─────────────────────────────────────────────
    #send(msg: JsonRpcMessage): void {
        this.#child?.stdin?.write(`${JSON.stringify(msg)}\n`);
    }

    #request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pendingRpc.set(id, { resolve, reject });
            this.#send({ jsonrpc: '2.0', id, method, params });
        });
    }

    #onLine(line: string): void {
        if (!line.trim()) return;
        let msg: JsonRpcMessage;
        try { msg = JSON.parse(line) as JsonRpcMessage; } catch { return; }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const d = this.#pendingRpc.get(msg.id);
            if (!d) return;
            this.#pendingRpc.delete(msg.id);
            if (msg.error) {
                const details = typeof msg.error.data?.['details'] === 'string' ? msg.error.data['details'] : '';
                d.reject(new Error(details ? `${msg.error.message}: ${details}` : msg.error.message));
            }
            else d.resolve(msg.result ?? {});
            return;
        }
        if (msg.method === 'session/update') this.#onSessionUpdate(msg.params ?? {});
        else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
            this.#onPermissionRequest(msg.id, msg.params ?? {});
        }
    }

    // ── incoming notifications/requests ───────────────────────────────
    #onSessionUpdate(params: Record<string, unknown>): void {
        const sessionId = String(params['sessionId'] ?? '');
        const update = (params['update'] ?? {}) as Record<string, unknown>;
        const kind = String(update['sessionUpdate'] ?? 'unknown');
        const event = `code_${kind}`;
        const session = this.#sessions.get(sessionId);
        if (session) session.lastUsedAt = Date.now();
        const captures = this.#replayCaptures.get(sessionId);
        if (captures) {
            for (const capture of captures) {
                capture.push({ event, sessionId, update });
            }
            return;
        }
        // Sanitized public lane (113.2 §5); raw payload stays host-side.
        publish('jwc', event, { sessionId, update });
    }

    #onPermissionRequest(rpcId: number | string, params: Record<string, unknown>): void {
        const permissionId = randomUUID();
        const sessionId = String(params['sessionId'] ?? '');
        const pending: PendingPermission & { respond: (r: Record<string, unknown>) => void } = {
            permissionId,
            sessionId,
            toolCall: (params['toolCall'] ?? {}) as Record<string, unknown>,
            options: (params['options'] ?? []) as Array<Record<string, unknown>>,
            requestedAt: Date.now(),
            respond: result => this.#send({ jsonrpc: '2.0', id: rpcId, result }),
        };
        this.#permissions.set(permissionId, pending);
        publish('jwc', 'code_permission_request', {
            permissionId, sessionId, toolCall: pending.toolCall, options: pending.options,
        });
    }

    // ── CodeSessionTransport ──────────────────────────────────────────
    async newSession(cwd: string, opts?: { model?: string }): Promise<CodeSessionInfo> {
        const settings = loadSettings();
        const max = Number((settings['code'] as Record<string, unknown> | undefined)?.['maxConcurrentSessions'] ?? DEFAULT_CODE_SETTINGS.maxConcurrentSessions);
        const live = [...this.#sessions.values()].filter(s => s.status !== 'closed');
        if (live.length >= max) throw new Error(`code.maxConcurrentSessions (${max}) reached`);
        await this.#ensureChild();
        const res = await this.#request('session/new', { cwd, mcpServers: [] });
        const sessionId = String(res['sessionId'] ?? '');
        if (!sessionId) throw new Error('engine returned no sessionId');
        if (opts?.model) {
            await this.#request('session/set_model', { sessionId, modelId: opts.model });
        }
        const info: CodeSessionInfo = { sessionId, cwd, status: 'idle', createdAt: Date.now(), lastUsedAt: Date.now() };
        this.#sessions.set(sessionId, info);
        publish('jwc', 'code_session_created', { sessionId, cwd });
        return info;
    }

    async loadSession(sessionId: string, cwd: string): Promise<CodeSessionInfo> {
        await this.#ensureChild();
        const stored = await this.#findStoredSession(sessionId, cwd);
        const replayCapture: CodeSessionReplayEvent[] = [];
        let captures = this.#replayCaptures.get(sessionId);
        if (!captures) {
            captures = new Set<CodeSessionReplayEvent[]>();
            this.#replayCaptures.set(sessionId, captures);
        }
        captures.add(replayCapture);
        try {
            await this.#request('session/load', { sessionId, cwd, mcpServers: [] });
        } finally {
            captures.delete(replayCapture);
            if (captures.size === 0) this.#replayCaptures.delete(sessionId);
        }
        const info: CodeSessionInfo = { sessionId, cwd, status: 'idle', createdAt: Date.now(), lastUsedAt: Date.now() };
        if (stored?.title) info.title = stored.title;
        if (replayCapture.length > 0) info.replayEvents = replayCapture;
        this.#sessions.set(sessionId, info);
        publish('jwc', 'code_session_loaded', { sessionId, cwd });
        return info;
    }

    async listStoredSessions(options: { cwd?: string; scope?: 'all' | 'cwd' } = {}): Promise<StoredCodeSessionInfo[]> {
        await this.#ensureChild();
        const scope = options.scope ?? (options.cwd ? 'cwd' : 'all');
        const res = await this.#request('session/list', { ...(scope === 'cwd' && options.cwd ? { cwd: options.cwd } : {}) });
        const sessions = (res['sessions'] ?? []) as Array<Record<string, unknown>>;
        return sessions
            .map(normalizeStoredSession)
            .sort((left, right) => (right.lastModified ?? 0) - (left.lastModified ?? 0));
    }

    async #findStoredSession(sessionId: string, cwd: string): Promise<StoredCodeSessionInfo | undefined> {
        try {
            const sessions = await this.listStoredSessions({ scope: 'cwd', cwd });
            return sessions.find(session => session.sessionId === sessionId);
        } catch {
            return undefined;
        }
    }

    async extMethod(sessionId: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        await this.#ensureChild();
        return await this.#request(method, { sessionId, ...params }) as Record<string, unknown>;
    }

    async forkSession(sessionId: string, cwd: string): Promise<CodeSessionInfo> {
        await this.#ensureChild();
        const res = await this.#request('session/fork', { sessionId, cwd, mcpServers: [] });
        const newSessionId = String(res['sessionId'] ?? '');
        if (!newSessionId) throw new Error('fork returned no sessionId');
        const info: CodeSessionInfo = { sessionId: newSessionId, cwd, status: 'idle', createdAt: Date.now(), lastUsedAt: Date.now() };
        this.#sessions.set(newSessionId, info);
        publish('jwc', 'code_session_forked', { sessionId: newSessionId, sourceSessionId: sessionId, cwd });
        return info;
    }

    async setSessionModel(sessionId: string, modelId: string): Promise<void> {
        await this.#request('session/set_model', { sessionId, modelId });
    }

    async prompt(sessionId: string, text: string): Promise<PromptAccepted> {
        const session = this.#sessions.get(sessionId);
        if (!session || session.status === 'closed') throw new Error(`unknown session: ${sessionId}`);
        await this.#ensureChild();
        session.status = 'streaming';
        session.lastUsedAt = Date.now();
        // Accept-then-stream: the turn settles via the bus, never a blocking HTTP response (113.2 §4).
        void this.#request('session/prompt', {
            sessionId,
            messageId: randomUUID(),
            prompt: [{ type: 'text', text }],
        }).then(res => {
            session.status = 'idle';
            publish('jwc', 'code_turn_done', { sessionId, stopReason: res['stopReason'] ?? 'unknown' });
        }).catch(err => {
            session.status = 'idle';
            publish('jwc', 'code_session_error', { sessionId, reason: err instanceof Error ? err.message : String(err) });
        });
        return { accepted: true, sessionId };
    }

    async cancel(sessionId: string): Promise<void> {
        await this.#ensureChild();
        this.#send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
        // Late permission requests after cancel must be answered as cancelled (ACP contract).
        for (const [id, p] of this.#permissions) {
            if (p.sessionId === sessionId) {
                p.respond({ outcome: { outcome: 'cancelled' } });
                this.#permissions.delete(id);
            }
        }
    }

    async setSessionConfig(sessionId: string, configId: string, valueId: string): Promise<void> {
        await this.#request('session/set_config_option', { sessionId, configId, value: valueId });
    }

    async closeSession(sessionId: string): Promise<void> {
        const session = this.#sessions.get(sessionId);
        if (!session) return;
        await this.#request('session/close', { sessionId }).catch(() => {});
        session.status = 'closed';
        this.#sessions.delete(sessionId);
        publish('jwc', 'code_session_closed', { sessionId });
    }

    listSessions(): CodeSessionInfo[] {
        return [...this.#sessions.values()];
    }

    listPendingPermissions(sessionId?: string): PendingPermission[] {
        const all = [...this.#permissions.values()].map(({ respond: _respond, ...rest }) => rest);
        return sessionId ? all.filter(p => p.sessionId === sessionId) : all;
    }

    answerPermission(permissionId: string, optionId: string | null): boolean {
        const pending = this.#permissions.get(permissionId);
        if (!pending) return false;
        pending.respond(optionId === null
            ? { outcome: { outcome: 'cancelled' } }
            : { outcome: { outcome: 'selected', optionId } });
        this.#permissions.delete(permissionId);
        return true;
    }

    async dispose(): Promise<void> {
        if (this.#idleReaper) { clearInterval(this.#idleReaper); this.#idleReaper = null; }
        for (const sessionId of [...this.#sessions.keys()]) await this.closeSession(sessionId).catch(() => {});
        this.#child?.stdin?.end();
        this.#child?.kill('SIGTERM');
        this.#child = null;
    }
}

export const acpHost: CodeSessionTransport = new AcpHost();
