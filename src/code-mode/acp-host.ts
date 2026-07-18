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
import type { Interface as ReadLineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publish } from '../core/event-bus.js';
import { loadSettings } from '../core/config.js';
import { CodeTransportError, DEFAULT_CODE_SETTINGS, type CodeSessionInfo, type CodeSessionReplayEvent, type CodeSessionTransport, type PendingPermission, type PromptAccepted, type StoredCodeSessionInfo } from './types.js';

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
    method: string;
    timer: ReturnType<typeof setTimeout>;
}

export type CodeCommandSource = 'env' | 'package' | 'path';

function resolveAcpCommand(): { cmd: string; args: string[]; binDir?: string; source: CodeCommandSource } {
    // Override for dev checkouts, e.g. JWC_ACP_CMD="bun /path/jawcode/packages/jwc/bin/jwc.js --mode acp"
    const override = process.env['JWC_ACP_CMD'];
    if (override && override.trim()) {
        const parts = override.trim().split(/\s+/);
        const cmd = parts[0];
        if (cmd) return { cmd, args: parts.slice(1), source: 'env' };
    }
    const candidates = [
        // External JWC runtime: prefer an explicitly installed package-local jawcode .bin before any stale global jwc shim. cli-jaw never bundles JWC.
        join(MODULE_DIR, '..', '..', '..', 'node_modules', '.bin', 'jwc'),
        join(MODULE_DIR, '..', '..', 'node_modules', '.bin', 'jwc'),
        join(process.cwd(), 'node_modules', '.bin', 'jwc'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return { cmd: candidate, args: ['--mode', 'acp'], binDir: dirname(candidate), source: 'package' };
    }
    return { cmd: 'jwc', args: ['--mode', 'acp'], source: 'path' };
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
    #readline: ReadLineInterface | null = null;
    #nextId = 1;
    #pendingRpc = new Map<number | string, Deferred>();
    #sessions = new Map<string, CodeSessionInfo>();
    #permissions = new Map<string, PendingPermission & { respond: (result: Record<string, unknown>) => void }>();
    #replayCaptures = new Map<string, Set<CodeSessionReplayEvent[]>>();
    #initialized: Promise<void> | null = null;
    #idleReaper: ReturnType<typeof setInterval> | null = null;
    /** true only after #handshake() RESOLVED; cleared on exit/respawn (061) */
    #ready = false;
    #commandSource: CodeCommandSource | null = null;

    // ── child lifecycle ───────────────────────────────────────────────
    async #ensureChild(): Promise<void> {
        if (this.#child && this.#child.exitCode === null && this.#initialized) return this.#initialized;
        const { cmd, args, binDir, source } = resolveAcpCommand();
        this.#ready = false;
        this.#commandSource = source;
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
        this.#readline = rl;
        rl.on('line', line => this.#onLine(line));
        child.once('error', () => {
            if (this.#child === child) this.#onChildExit(null);
        });
        child.on('exit', code => {
            if (this.#child === child) this.#onChildExit(code);
        });
        // On handshake failure, reset #initialized so the NEXT call respawns instead
        // of returning the same rejected promise forever (no auto-recovery otherwise).
        this.#initialized = this.#handshake().catch(err => {
            this.#initialized = null;
            try { this.#child?.kill('SIGTERM'); } catch { /* ignore */ }
            this.#child = null;
            throw err;
        });
        void this.#initialized.then(() => { this.#ready = true; }, () => { /* handled above */ });
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
        this.#ready = false;
        for (const [, d] of this.#pendingRpc) {
            clearTimeout(d.timer);
            d.reject(new CodeTransportError('unavailable', `acp child exited (code ${code})`));
        }
        this.#pendingRpc.clear();
        for (const s of this.#sessions.values()) s.status = 'closed';
        this.#permissions.clear();
        this.#child = null;
        this.#readline?.close();
        this.#readline = null;
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
            if (!this.#child || this.#child.exitCode !== null || !this.#child.stdin?.writable) {
                reject(new CodeTransportError('unavailable', 'acp child unavailable'));
                return;
            }
            const configured = Number(process.env['JWC_ACP_RPC_TIMEOUT_MS'] ?? 30_000);
            const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 30_000;
            const timer = setTimeout(() => {
                this.#pendingRpc.delete(id);
                reject(new CodeTransportError('rpc_timeout', `${method} timed out`));
            }, timeoutMs);
            timer.unref();
            this.#pendingRpc.set(id, { resolve, reject, method, timer });
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
            clearTimeout(d.timer);
            if (msg.error) {
                const details = typeof msg.error.data?.['details'] === 'string' ? msg.error.data['details'] : '';
                const message = details ? `${msg.error.message}: ${details}` : msg.error.message;
                d.reject(d.method === 'session/set_model' && /model|unsupported|invalid/i.test(message)
                    ? new CodeTransportError('unsupported_model', message)
                    : new Error(message));
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
        if (live.length >= max) throw new CodeTransportError('unavailable', `code.maxConcurrentSessions (${max}) reached`);
        await this.#ensureChild();
        let res: Record<string, unknown>;
        try {
            res = await this.#request('session/new', { cwd, mcpServers: [] });
        } catch (error) {
            if (error instanceof CodeTransportError && error.code === 'rpc_timeout') {
                // The remote side may have created a session whose id was in a
                // late response. Terminate the child so that unknown session
                // cannot survive as an orphan.
                await this.#terminateChild();
            }
            throw error;
        }
        const sessionId = String(res['sessionId'] ?? '');
        if (!sessionId) throw new Error('engine returned no sessionId');
        if (opts?.model) {
            try {
                await this.#request('session/set_model', { sessionId, modelId: opts.model });
            } catch (error) {
                await this.#request('session/close', { sessionId }).catch(async () => {
                    await this.#terminateChild();
                });
                throw error;
            }
        }
        const info: CodeSessionInfo = { sessionId, cwd, status: 'idle', createdAt: Date.now(), lastUsedAt: Date.now(), modelId: opts?.model ?? null };
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
        const info: CodeSessionInfo = { sessionId, cwd, status: 'idle', createdAt: Date.now(), lastUsedAt: Date.now(), modelId: null };
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
        const info: CodeSessionInfo = { sessionId: newSessionId, cwd, status: 'idle', createdAt: Date.now(), lastUsedAt: Date.now(), modelId: null };
        this.#sessions.set(newSessionId, info);
        publish('jwc', 'code_session_forked', { sessionId: newSessionId, sourceSessionId: sessionId, cwd });
        return info;
    }

    async setSessionModel(sessionId: string, modelId: string): Promise<CodeSessionInfo> {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            throw new CodeTransportError('unknown_session', `unknown session: ${sessionId}`);
        }
        if (session.status === 'closed') {
            // Retained after an ACP child exit: the remote side is gone, so the
            // documented contract maps this to 503 (unavailable), not 404.
            throw new CodeTransportError('unavailable', `session unavailable after acp child exit: ${sessionId}`);
        }
        await this.#ensureChild();
        await this.#request('session/set_model', { sessionId, modelId });
        session.modelId = modelId;
        session.lastUsedAt = Date.now();
        publish('jwc', 'code_session_model_changed', { sessionId, modelId });
        return { ...session };
    }

    async prompt(sessionId: string, text: string): Promise<PromptAccepted> {
        const session = this.#sessions.get(sessionId);
        if (!session) throw new CodeTransportError('unknown_session', `unknown session: ${sessionId}`);
        if (session.status === 'closed') {
            throw new CodeTransportError('unavailable', `session unavailable after acp child exit: ${sessionId}`);
        }
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
        if (session.status === 'closed') {
            // Retained after an ACP child exit: no remote close is possible, and
            // attempting one would spawn a fresh child only to kill it. Remove
            // the entry locally so stale sessions cannot accumulate.
            this.#sessions.delete(sessionId);
            publish('jwc', 'code_session_closed', { sessionId });
            return;
        }
        await this.#request('session/close', { sessionId }).catch(async () => {
            await this.#terminateChild();
        });
        session.status = 'closed';
        this.#sessions.delete(sessionId);
        publish('jwc', 'code_session_closed', { sessionId });
    }

    listSessions(): CodeSessionInfo[] {
        // Live-list contract: entries retained as 'closed' after a child exit are
        // not selectable live sessions; they stay in the map only for the 503
        // unavailable mapping until explicitly closed.
        return [...this.#sessions.values()].filter(s => s.status !== 'closed');
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
        this.#ready = false;
        if (this.#idleReaper) { clearInterval(this.#idleReaper); this.#idleReaper = null; }
        for (const sessionId of [...this.#sessions.keys()]) await this.closeSession(sessionId).catch(() => {});
        for (const [, deferred] of this.#pendingRpc) {
            clearTimeout(deferred.timer);
            deferred.reject(new CodeTransportError('unavailable', 'acp host disposed'));
        }
        this.#pendingRpc.clear();
        this.#readline?.close();
        this.#readline = null;
        await this.#terminateChild();
        this.#initialized = null;
    }

    async #terminateChild(): Promise<void> {
        const child = this.#child;
        if (!child) return;
        child.stdin?.end();
        if (child.exitCode !== null) return;
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let killTimer: ReturnType<typeof setTimeout> | null = null;
            let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
            const done = (): void => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (fallbackTimer) clearTimeout(fallbackTimer);
                resolve();
            };
            child.once('exit', done);
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL');
            }, 1_000);
            killTimer.unref();
            fallbackTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                reject(new CodeTransportError('unavailable', 'acp child did not exit after SIGKILL'));
            }, 2_000);
            fallbackTimer.unref();
        });
    }

    /** 061 — resident readiness snapshot for the capability fast-path. */
    capabilitySnapshot(): { ready: boolean; commandSource: CodeCommandSource | null } {
        const alive = this.#child !== null && this.#child.exitCode === null;
        return { ready: alive && this.#ready, commandSource: this.#commandSource };
    }

    diagnosticSnapshot(): { childAlive: boolean; pendingRpcCount: number; sessionCount: number } {
        return {
            childAlive: this.#child !== null && this.#child.exitCode === null,
            pendingRpcCount: this.#pendingRpc.size,
            sessionCount: this.#sessions.size,
        };
    }
}

const acpHostInstance = new AcpHost();
export const acpHost: CodeSessionTransport = acpHostInstance;
export function getAcpHostDiagnosticSnapshot(): { childAlive: boolean; pendingRpcCount: number; sessionCount: number } {
    return acpHostInstance.diagnosticSnapshot();
}

// ── 061 — side-effect-free capability probe ─────────────────────────
// No persistent child, no session: a throwaway `--mode acp` child performs the
// initialize handshake and is terminated. The response NEVER carries binary
// paths, tokens, or stderr text (bounded reasons only).

export type CodeCapabilityReason = 'ok' | 'missing_binary' | 'acp_unsupported' | 'temporarily_unavailable';

export interface CodeCapabilityProbe {
    available: boolean;
    reason: CodeCapabilityReason;
    commandSource: CodeCommandSource;
    acpProtocolVersion?: number;
}

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
let probeCache: { at: number; result: CodeCapabilityProbe } | null = null;
let probeInFlight: Promise<CodeCapabilityProbe> | null = null;

function runThrowawayProbe(): Promise<CodeCapabilityProbe> {
    const { cmd, args, binDir, source } = resolveAcpCommand();
    return new Promise<CodeCapabilityProbe>(resolve => {
        let settled = false;
        let child: ChildProcess | null = null;
        const finish = (result: CodeCapabilityProbe): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child?.kill('SIGTERM'); } catch { /* already gone */ }
            resolve(result);
        };
        const timer = setTimeout(() => {
            finish({ available: false, reason: 'temporarily_unavailable', commandSource: source });
        }, PROBE_TIMEOUT_MS);
        try {
            child = spawn(cmd, args, {
                stdio: ['pipe', 'pipe', 'ignore'],
                env: {
                    ...process.env,
                    JWC_BRAND_NAME: 'jwc',
                    PATH: binDir ? `${binDir}:${process.env['PATH'] ?? ''}` : process.env['PATH'],
                },
            });
        } catch {
            finish({ available: false, reason: 'temporarily_unavailable', commandSource: source });
            return;
        }
        child.on('error', (err: NodeJS.ErrnoException) => {
            finish({
                available: false,
                reason: err.code === 'ENOENT' ? 'missing_binary' : 'temporarily_unavailable',
                commandSource: source,
            });
        });
        child.on('exit', () => {
            // exited before the handshake answered — a resolvable but broken or
            // pre-ACP binary dies immediately
            finish({ available: false, reason: 'acp_unsupported', commandSource: source });
        });
        const rl = createInterface({ input: child.stdout! });
        rl.on('line', line => {
            try {
                const msg = JSON.parse(line) as JsonRpcMessage;
                if (msg.id !== 'probe') return;
                if (msg.error) {
                    finish({ available: false, reason: 'acp_unsupported', commandSource: source });
                    return;
                }
                const version = numberField(msg.result?.['protocolVersion']);
                finish({
                    available: true,
                    reason: 'ok',
                    commandSource: source,
                    ...(version !== undefined ? { acpProtocolVersion: version } : {}),
                });
            } catch { /* non-JSON banner noise — keep waiting until timeout */ }
        });
        const request: JsonRpcMessage = {
            jsonrpc: '2.0',
            id: 'probe',
            method: 'initialize',
            params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
        };
        child.stdin?.write(`${JSON.stringify(request)}\n`);
    });
}

export async function probeCodeCapabilities(opts: { refresh?: boolean } = {}): Promise<CodeCapabilityProbe> {
    // fast-path BEFORE the cache: a live initialized resident child is proof
    const snapshot = acpHostInstance.capabilitySnapshot();
    if (snapshot.ready) {
        return { available: true, reason: 'ok', commandSource: snapshot.commandSource ?? 'path' };
    }
    if (!opts.refresh && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return probeCache.result;
    }
    if (!probeInFlight) {
        probeInFlight = runThrowawayProbe().then(result => {
            probeCache = { at: Date.now(), result };
            probeInFlight = null;
            return result;
        });
    }
    return probeInFlight;
}
