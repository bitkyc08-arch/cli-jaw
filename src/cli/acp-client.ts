// ─── ACP Client: JSON-RPC 2.0 over stdio ──────────────────────────
// Communicates with `copilot --acp` process via NDJSON.
// Official ACP spec: https://agentclientprotocol.com

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';

export class AcpClient extends EventEmitter {
    model: any;
    workDir: any;
    permissions: string;
    sessionId: any;
    proc: any;
    _reqId: number;
    _pending: Map<number, any>;
    _buffer: string;
    _activityPing: (() => void) | null;
    _agentCapabilities: any;

    constructor({ model, workDir, permissions = 'auto' }: { model?: any; workDir?: any; permissions?: string } = {}) {
        super();
        this.model = model;
        this.workDir = workDir;
        this.permissions = permissions;
        this.sessionId = null;
        this.proc = null;
        this._reqId = 0;
        this._pending = new Map(); // id → { resolve, reject, timer }
        this._buffer = '';
        this._activityPing = null;
        this._agentCapabilities = null;
    }

    /** Build copilot process args from model + permission mode */
    buildSpawnArgs() {
        const args = ['--acp'];
        if (this.model) args.push('--model', this.model);

        // In cli-jaw, "auto" is intended as unattended full-permission mode.
        if (this.permissions === 'auto' || this.permissions === 'yolo') {
            args.push('--allow-all-tools', '--allow-all-paths', '--allow-all-urls');
        }
        return args;
    }

    // ─── Process lifecycle ──────────────────────

    /** Spawn the copilot --acp process */
    spawn() {
        const args = this.buildSpawnArgs();

        this.proc = spawn('copilot', args, {
            cwd: this.workDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        // NDJSON line parser on stdout
        const rl = createInterface({ input: this.proc.stdout });
        rl.on('line', (line) => this._handleLine(line));

        // Capture stderr for debugging + heartbeat
        this.proc.stderr.on('data', (chunk: any) => {
            this._activityPing?.();  // stderr activity = agent is alive
            const text = chunk.toString().trim();
            if (text && process.env.DEBUG) {
                console.error(`[acp:stderr] ${text}`);
            }
        });

        this.proc.on('exit', (code: any, signal: any) => {
            // Reject all pending requests
            for (const [id, p] of this._pending) {
                clearTimeout(p.timer);
                p.reject(new Error(`ACP process exited (code=${code}, signal=${signal})`));
            }
            this._pending.clear();
            this.emit('exit', { code, signal });
        });

        this.proc.on('error', (err: any) => {
            this.emit('error', err);
        });

        return this;
    }

    /** Kill the process */
    kill() {
        if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGTERM');
        }
    }

    // ─── JSON-RPC transport ──────────────────────

    /** Send a JSON-RPC request and return a promise for the result */
    request(method: any, params = {}, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (!this.proc?.stdin?.writable) {
                reject(new Error(`ACP stdin is not writable: ${method}`));
                return;
            }
            const id = ++this._reqId;
            const msg = { jsonrpc: '2.0', method, id, params };

            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`ACP request timeout: ${method} (id=${id})`));
            }, timeoutMs);

            this._pending.set(id, { resolve, reject, timer });
            this._write(msg);
        });
    }

    /**
     * Send a request with activity-based idle timeout.
     * Returns { promise, activityPing } — call activityPing() on every activity
     * event (tool_call, thought, message) to reset the idle timer. Two timers:
     *   - idle timer (idleMs): resets on each activityPing() call
     *   - absolute timer (maxMs): hard cap, never resets
     */
    requestWithActivityTimeout(method: any, params = {}, idleMs = 120000, maxMs = 1200000) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined, absTimer: ReturnType<typeof setTimeout> | undefined, settled = false;

        const promise = new Promise((resolve, reject) => {
            if (!this.proc?.stdin?.writable) {
                reject(new Error(`ACP stdin is not writable: ${method}`));
                return;
            }
            const id = ++this._reqId;
            const msg = { jsonrpc: '2.0', method, id, params };

            const cleanup = () => {
                settled = true;
                clearTimeout(idleTimer);
                clearTimeout(absTimer);
            };

            const onTimeout = (reason: any) => {
                cleanup();
                this._pending.delete(id);
                reject(new Error(`ACP request timeout (${reason}): ${method} (id=${id})`));
            };

            // Idle timer — resets on activity
            const resetIdle = () => {
                if (settled) return;
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => onTimeout(`idle ${idleMs / 1000}s`), idleMs);
            };

            // Absolute timer — never resets
            absTimer = setTimeout(() => onTimeout(`max ${maxMs / 1000}s`), maxMs);

            // Wrap resolve/reject to cleanup timers
            this._pending.set(id, {
                resolve: (val: any) => { cleanup(); resolve(val); },
                reject: (err: any) => { cleanup(); reject(err); },
                timer: idleTimer, // for process exit cleanup
            });

            resetIdle();
            this._activityPing = resetIdle;
            this._write(msg);
        });

        return {
            promise,
            activityPing: () => { if (!settled && this._activityPing) this._activityPing(); },
        };
    }

    /** Send a JSON-RPC notification (no response expected) */
    notify(method: any, params = {}) {
        this._write({ jsonrpc: '2.0', method, params });
    }

    _write(msg: any) {
        if (!this.proc?.stdin?.writable) return;
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }

    _handleLine(line: any) {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg;
        try { msg = JSON.parse(trimmed); } catch {
            if (process.env.DEBUG) console.log(`[acp] non-JSON line: ${trimmed.slice(0, 100)}`);
            return;
        }

        // Any valid JSON-RPC message = agent is alive → reset idle timer
        this._activityPing?.();

        // Response to a request (has id)
        if (msg.id != null && this._pending.has(msg.id)) {
            const p = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            clearTimeout(p.timer);

            if (msg.error) {
                const details = msg.error.data ? ` ${JSON.stringify(msg.error.data)}` : '';
                p.reject(new Error(`ACP error [${msg.error.code}]: ${msg.error.message}${details}`));
            } else {
                p.resolve(msg.result);
            }
            return;
        }

        // Agent request to client (has id + method) — auto-respond
        if (msg.id != null && msg.method) {
            this._handleAgentRequest(msg);
            return;
        }

        // Notification from agent (no id, has method)
        if (msg.method) {
            if (msg.method === 'session/cancelled') {
                console.warn(`[acp:cancelled] ${JSON.stringify(msg.params || {}).slice(0, 200)}`);
            }
            this.emit(msg.method, msg.params);
            return;
        }
    }

    /** Handle requests FROM the agent (permission requests, file ops, etc.) */
    _handleAgentRequest(msg: any) {
        switch (msg.method) {
            case 'session/request_permission': {
                // Auto-approve all permissions (yolo/auto mode)
                const options = msg.params?.options || [];
                const allowOption = options.find((o: any) =>
                    o.name?.toLowerCase().includes('allow') ||
                    o.name?.toLowerCase().includes('approve') ||
                    o.name?.toLowerCase().includes('yes')
                ) || options[0];

                this._write({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                        outcome: allowOption
                            ? {
                                outcome: 'selected',
                                optionId: allowOption.value || allowOption.id || allowOption.optionId || 'allow',
                            }
                            : {
                                outcome: 'selected',
                                optionId: options[0]?.value || options[0]?.id || options[0]?.optionId || 'allow',
                            },
                    },
                });
                break;
            }
            default:
                // Unknown agent request — always log + respond with error
                console.warn(`[acp:unhandled] agent request: ${msg.method} params=${JSON.stringify(msg.params || {}).slice(0, 200)}`);
                this._write({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32601, message: `Method not supported: ${msg.method}` },
                });
        }
    }

    // ─── ACP protocol methods ──────────────────────

    /** Initialize the ACP connection */
    async initialize() {
        const result = await this.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'cli-jaw', version: '0.1.0' },
            capabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
            },
        });
        this._agentCapabilities = result;
        return result;
    }

    /** Create a new session */
    async createSession(workDir = this.workDir, mcpServers: any[] = []) {
        const result = await this.request('session/new', {
            cwd: workDir,
            mcpServers,
        }) as Record<string, any>;
        this.sessionId = result?.sessionId;
        return result;
    }

    /** Send a prompt to the agent (activity-based timeout) */
    prompt(text: any, sessionId: any = null) {
        const sid = sessionId || this.sessionId;
        if (!sid) throw new Error('No session. Call createSession first.');
        return this.requestWithActivityTimeout('session/prompt', {
            sessionId: sid,
            prompt: [{ type: 'text', text }],
        }, 1200000, 14400000); // idle 20min, max 4h
    }

    /** Resume a previous session (if agent supports loadSession capability) */
    async loadSession(sessionId: any, workDir = this.workDir, mcpServers: any[] = []) {
        const result = await this.request('session/load', {
            sessionId,
            cwd: workDir,
            mcpServers,
        });
        this.sessionId = sessionId;
        return result;
    }

    /** Cancel current operation */
    cancel(sessionId: any = null) {
        const sid = sessionId || this.sessionId;
        if (sid) this.notify('session/cancel', { sessionId: sid });
    }

    /** Graceful shutdown */
    async shutdown() {
        try { await this.request('shutdown', {}, 5000); } catch { /* ignore */ }
        this.kill();
    }

    /** Check if agent supports a capability */
    hasCapability(name: any) {
        return !!this._agentCapabilities?.[name];
    }
}
