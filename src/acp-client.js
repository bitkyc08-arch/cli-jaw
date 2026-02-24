// ─── ACP Client: JSON-RPC 2.0 over stdio ──────────────────────────
// Communicates with `copilot --acp` process via NDJSON.
// Official ACP spec: https://agentclientprotocol.com

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';

export class AcpClient extends EventEmitter {
    constructor({ model, workDir, permissions = 'safe' } = {}) {
        super();
        this.model = model;
        this.workDir = workDir;
        this.permissions = permissions;
        this.sessionId = null;
        this.proc = null;
        this._reqId = 0;
        this._pending = new Map(); // id → { resolve, reject, timer }
        this._buffer = '';
    }

    // ─── Process lifecycle ──────────────────────

    /** Spawn the copilot --acp process */
    spawn() {
        const args = ['--acp'];
        if (this.model) args.push('--model', this.model);

        // Permission flags
        if (this.permissions === 'yolo') {
            args.push('--allow-all-tools', '--allow-all-paths', '--allow-all-urls');
        } else if (this.permissions === 'auto') {
            args.push('--allow-all-tools');
        }

        this.proc = spawn('copilot', args, {
            cwd: this.workDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        // NDJSON line parser on stdout
        const rl = createInterface({ input: this.proc.stdout });
        rl.on('line', (line) => this._handleLine(line));

        // Capture stderr for debugging
        this.proc.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text && process.env.DEBUG) {
                console.error(`[acp:stderr] ${text}`);
            }
        });

        this.proc.on('exit', (code, signal) => {
            // Reject all pending requests
            for (const [id, p] of this._pending) {
                clearTimeout(p.timer);
                p.reject(new Error(`ACP process exited (code=${code}, signal=${signal})`));
            }
            this._pending.clear();
            this.emit('exit', { code, signal });
        });

        this.proc.on('error', (err) => {
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
    request(method, params = {}, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
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

    /** Send a JSON-RPC notification (no response expected) */
    notify(method, params = {}) {
        this._write({ jsonrpc: '2.0', method, params });
    }

    _write(msg) {
        if (!this.proc?.stdin?.writable) return;
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }

    _handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg;
        try { msg = JSON.parse(trimmed); } catch {
            if (process.env.DEBUG) console.log(`[acp] non-JSON line: ${trimmed.slice(0, 100)}`);
            return;
        }

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

        // Notification from agent (no id, has method)
        if (msg.method) {
            this.emit(msg.method, msg.params);
            return;
        }

        // Agent request to client (has id + method) — auto-respond
        if (msg.id != null && msg.method) {
            this._handleAgentRequest(msg);
            return;
        }
    }

    /** Handle requests FROM the agent (permission requests, file ops, etc.) */
    _handleAgentRequest(msg) {
        switch (msg.method) {
            case 'session/request_permission': {
                // Auto-approve all permissions (yolo/auto mode)
                const options = msg.params?.options || [];
                const allowOption = options.find(o =>
                    o.name?.toLowerCase().includes('allow') ||
                    o.name?.toLowerCase().includes('approve') ||
                    o.name?.toLowerCase().includes('yes')
                ) || options[0];

                this._write({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                        outcome: allowOption
                            ? { outcome: 'selected', optionId: allowOption.value }
                            : { outcome: 'selected', optionId: options[0]?.value || 'allow' },
                    },
                });
                break;
            }
            default:
                // Unknown agent request — respond with error
                this._write({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32601, message: `Method not supported: ${msg.method}` },
                });
                if (process.env.DEBUG) {
                    console.log(`[acp] unsupported agent request: ${msg.method}`);
                }
        }
    }

    // ─── ACP protocol methods ──────────────────────

    /** Initialize the ACP connection */
    async initialize() {
        const result = await this.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'cli-claw', version: '0.1.0' },
            capabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
            },
        });
        this._agentCapabilities = result;
        return result;
    }

    /** Create a new session */
    async createSession(workDir = this.workDir, mcpServers = []) {
        const result = await this.request('session/new', {
            cwd: workDir,
            mcpServers,
        });
        this.sessionId = result?.sessionId;
        return result;
    }

    /** Send a prompt to the agent */
    async prompt(text, sessionId = null) {
        const sid = sessionId || this.sessionId;
        if (!sid) throw new Error('No session. Call createSession first.');
        return this.request('session/prompt', {
            sessionId: sid,
            prompt: [{ type: 'text', text }],
        }, 300000); // 5 min timeout for prompts
    }

    /** Resume a previous session (if agent supports loadSession capability) */
    async loadSession(sessionId, workDir = this.workDir, mcpServers = []) {
        const result = await this.request('session/load', {
            sessionId,
            cwd: workDir,
            mcpServers,
        });
        this.sessionId = sessionId;
        return result;
    }

    /** Cancel current operation */
    cancel(sessionId = null) {
        const sid = sessionId || this.sessionId;
        if (sid) this.notify('session/cancel', { sessionId: sid });
    }

    /** Graceful shutdown */
    async shutdown() {
        try { await this.request('shutdown', {}, 5000); } catch { /* ignore */ }
        this.kill();
    }

    /** Check if agent supports a capability */
    hasCapability(name) {
        return !!this._agentCapabilities?.[name];
    }
}
