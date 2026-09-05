import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ownProcess, type OwnedProcess, type OwnedProcessOptions } from '../../spawn/process-kill.js';
import { releaseChildOutputAfterExit } from '../../spawn/exit-drain.js';
import type { RuntimeRequests } from '../requests.js';
import { AcpCallbacks, type AcpRequestOwner } from './callbacks.js';
import { AcpConnection } from './connection.js';
import { parseAcpSelectConfigs } from './config.js';
import { AcpNotificationQueue } from './notification-queue.js';
import type { RpcFrame } from './wire.js';

export type AcpTurnOwner = Omit<AcpRequestOwner, 'nativeSessionId'>;
export type AcpNotificationConsumer = (frame: RpcFrame, signal: AbortSignal) => void | Promise<void>;
export interface AcpSessionOptions {
    permissions: unknown;
    promptTimeoutMs: number;
    requestTimeoutMs?: number;
    controlTimeoutMs?: number;
    drainTimeoutMs?: number;
    ownedProcessOptions?: OwnedProcessOptions;
    registry?: RuntimeRequests;
    clientMetadata?: Record<string, unknown>;
    failed?(error: Error): void;
}
type Request = ReturnType<AcpConnection['request']>;
type Active = {
    owner: AcpRequestOwner; queue: AcpNotificationQueue; consume: AcpNotificationConsumer;
    request: Request | null; ready: Promise<Request | null>; resolveReady(value: Request | null): void;
    terminal: boolean; stopped: boolean; cancelling: Promise<void> | null;
};

export function acpRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('acp_invalid_object');
    return value as Record<string, unknown>;
}
function acpString(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('acp_invalid_string');
    return value;
}
export function validateAcpSessionOptions(options: AcpSessionOptions): void {
    for (const timeout of [options.promptTimeoutMs, options.requestTimeoutMs ?? 30_000,
        options.controlTimeoutMs ?? 5_000, options.drainTimeoutMs ?? 5_000]) {
        if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new Error('acp_invalid_timeout');
    }
}

/** One process/session, reusable only after terminal, callback writes and notifications drain. */
export class AcpSession {
    readonly connection: AcpConnection;
    private readonly owner: OwnedProcess;
    private readonly callbacks: AcpCallbacks;
    private readonly exited: Promise<void>;
    private cleanupExitDrain: (() => void) | null = null;
    private active: Active | null = null;
    private failure: Error | null = null;
    private started = false;
    private ready = false;
    private controlBusy = false;
    private replay = false;
    private id = '';
    private configs: unknown = [];
    private capabilities: Record<string, unknown> = {};
    private stderrCount = 0;

    constructor(readonly child: ChildProcessWithoutNullStreams, private readonly options: AcpSessionOptions) {
        this.owner = ownProcess(child, options.ownedProcessOptions);
        this.exited = new Promise(resolve => { child.once('exit', () => resolve()); child.once('close', () => resolve()); });
        let connection: AcpConnection | undefined;
        try {
            validateAcpSessionOptions(options);
            if (!child.stdin || !child.stdout || !child.stderr) throw new Error('acp_stdio_unavailable');
            this.connection = connection = new AcpConnection(child, { frame: frame => this.frame(frame), failed: error => this.retire(error) });
            this.callbacks = new AcpCallbacks(this.connection, { permissions: options.permissions,
                ...(options.registry === undefined ? {} : { registry: options.registry }),
                getOwner: () => this.active && !this.active.terminal && this.alive ? this.active.owner : null });
            this.cleanupExitDrain = releaseChildOutputAfterExit(child);
            child.stderr.on('data', this.consumeStderr);
            child.stderr.on('error', this.stderrError);
            child.once('close', () => this.cleanupIO());
            if (child.exitCode !== null || child.signalCode !== null) this.retire(new Error('acp_child_exit'));
        } catch (error) {
            connection?.close(new Error('acp_setup_failed'));
            this.owner.terminate('startup-failed');
            throw error;
        }
    }
    get alive(): boolean { return !this.failure && this.connection.alive; }
    get idle(): boolean { return this.alive && this.ready && !this.controlBusy && !this.active && this.callbacks.idle; }
    get nativeSessionId(): string { return this.id; }
    get agentCapabilities(): Record<string, unknown> { return structuredClone(this.capabilities); }
    get stderrBytes(): number { return this.stderrCount; }
    getConfigOptions(): unknown { return structuredClone(this.configs); }

    private consumeStderr = (chunk: Buffer) => {
        this.stderrCount = Math.min(Number.MAX_SAFE_INTEGER, this.stderrCount + chunk.length);
    };
    private stderrError = () => this.retire(new Error('acp_stderr_error'));
    private cleanupIO(): void {
        this.cleanupExitDrain?.(); this.cleanupExitDrain = null;
        this.child.stderr?.off('data', this.consumeStderr);
        this.child.stdin?.destroy(); this.child.stdout?.destroy(); this.child.stderr?.destroy();
    }
    private updateConfigs(value: unknown): void {
        this.configs = parseAcpSelectConfigs(value).map(config => ({ ...config, type: 'select' }));
    }
    private async rpc(method: string, params: unknown, apply?: (result: unknown) => void): Promise<unknown> {
        const request = this.connection.request(method, params, this.options.requestTimeoutMs ?? 30_000,
            frame => { if ('result' in frame) apply?.(frame.result); });
        await request.dispatched;
        return request.result;
    }

    async start(input: { cwd: string; resumeSessionId?: string; authMethodId?: string }): Promise<void> {
        if (this.started || !this.alive) throw new Error('acp_start_unavailable');
        this.started = true; this.replay = true;
        try {
            if (!isAbsolute(input.cwd)) throw new Error('acp_invalid_cwd');
            const init = acpRecord(await this.rpc('initialize', { protocolVersion: 1,
                clientInfo: { name: 'cli-jaw', version: '1' },
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
                    ...(this.options.clientMetadata === undefined ? {} : { _meta: this.options.clientMetadata }) } }));
            if (init['protocolVersion'] !== 1) throw new Error('acp_protocol_unsupported');
            this.capabilities = acpRecord(init['agentCapabilities']);
            if (input.authMethodId !== undefined) {
                const method = acpString(input.authMethodId);
                const methods = init['authMethods'];
                if (!Array.isArray(methods) || !methods.some(item => acpRecord(item)['id'] === method)) throw new Error('acp_auth_method_unavailable');
                await this.rpc('authenticate', { methodId: method });
            }
            const load = input.resumeSessionId !== undefined;
            if (load) {
                if (this.capabilities['loadSession'] !== true) throw new Error('acp_resume_unsupported');
                this.id = acpString(input.resumeSessionId);
            }
            await this.rpc(load ? 'session/load' : 'session/new', {
                ...(load ? { sessionId: this.id } : {}), cwd: input.cwd, mcpServers: [],
            }, value => {
                const setup = acpRecord(value);
                if (!load) this.id = acpString(setup['sessionId']);
                this.updateConfigs(setup['configOptions']);
            });
            await this.bounded(this.callbacks.drain(), this.options.drainTimeoutMs ?? 5_000, 'acp_drain_timeout');
            this.assertAlive(); this.ready = true;
        } catch (error) { this.retire(this.error(error)); throw error; }
        finally { this.replay = false; }
    }

    async setConfigOption(configId: string, value: string): Promise<void> {
        if (!this.idle) throw new Error('acp_config_busy');
        this.controlBusy = true;
        try {
            await this.rpc('session/set_config_option', { sessionId: this.id, configId, value }, result => {
                const response = acpRecord(result);
                if (!Array.isArray(response['configOptions'])) throw new Error('acp_missing_config_options');
                this.updateConfigs(response['configOptions']);
            });
            await this.bounded(this.callbacks.drain(), this.options.drainTimeoutMs ?? 5_000, 'acp_drain_timeout');
            this.assertAlive();
        } catch (error) { this.retire(this.error(error)); throw error; }
        finally { this.controlBusy = false; }
    }

    async prompt(parts: ReadonlyArray<unknown>, source: AcpTurnOwner, consume: AcpNotificationConsumer): Promise<Record<string, unknown>> {
        const { runId, sessionId, scope, turnId } = source.binding;
        const predicate = source.isCurrent, emit = source.emit, parentItemId = source.parentItemId;
        const current = () => { try { return predicate() === true; } catch { return false; } };
        if (!this.idle || !current() || !this.idle) throw new Error('acp_prompt_unavailable');
        this.callbacks.beginRun();
        let resolveReady!: Active['resolveReady'];
        const ready = new Promise<Request | null>(resolve => { resolveReady = resolve; });
        const active: Active = { owner: { binding: { runId, sessionId, scope, turnId }, nativeSessionId: this.id, emit,
            ...(parentItemId === undefined ? {} : { parentItemId }),
            isCurrent: () => this.active === active && this.alive && (active.stopped || current()) },
            queue: new AcpNotificationQueue(error => this.retire(error)), consume, request: null, ready, resolveReady,
            terminal: false, stopped: false, cancelling: null };
        this.active = active; // callbacks may arrive synchronously from a test peer during write()
        try {
            const request = this.connection.request('session/prompt', { sessionId: this.id, prompt: parts }, this.options.promptTimeoutMs, () => {
                active.terminal = true; active.queue.seal();
                this.callbacks.cancelRun(active.owner.binding.runId);
            });
            active.request = request; resolveReady(request);
            await request.dispatched;
            const result = acpRecord(await request.result);
            const stopReason = result['stopReason'];
            if (typeof stopReason !== 'string' || !['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(stopReason)) {
                throw new Error('acp_invalid_stop_reason');
            }
            await this.drain(active);
            if (active.cancelling) await active.cancelling;
            this.assertAlive();
            return result;
        } catch (error) { this.retire(this.error(error)); throw error; }
        finally {
            resolveReady(null);
            this.callbacks.cancelRun(active.owner.binding.runId);
            if (this.active === active) this.active = null;
        }
    }

    cancel(): Promise<void> {
        const active = this.active;
        if (!active) return Promise.resolve();
        if (active.cancelling) return active.cancelling;
        active.stopped = true;
        this.callbacks.cancelRun(active.owner.binding.runId);
        const operation = (async () => {
            const request = active.request ?? await active.ready;
            if (!request) { this.assertAlive(); return; }
            await request.dispatched;
            await this.connection.notify('session/cancel', { sessionId: this.id });
            const result = acpRecord(await request.result);
            if (result['stopReason'] !== 'cancelled') throw new Error('acp_cancel_raced_completion');
            await this.drain(active);
            this.assertAlive();
        })();
        const cancelling = this.bounded(operation, this.options.controlTimeoutMs ?? 5_000, 'acp_cancel_timeout')
            .catch(error => { this.retire(this.error(error)); throw error; });
        void cancelling.catch(() => undefined);
        active.cancelling = cancelling;
        return cancelling;
    }

    private frame(frame: RpcFrame): void {
        if (this.failure || !('method' in frame)) return;
        const active = this.active;
        if ('id' in frame) {
            if (active?.terminal) { this.retire(new Error('acp_request_after_terminal')); return; }
            this.callbacks.handle(frame); return;
        }
        if (frame.method !== 'session/update') return; // unsupported extensions are metadata-only
        const params = acpRecord(frame.params);
        if (this.id && params['sessionId'] !== this.id) throw new Error('acp_wrong_session');
        const update = acpRecord(params['update']);
        if (update['sessionUpdate'] === 'config_option_update') { this.updateConfigs(update['configOptions']); return; }
        if (this.replay || acpRecord(params['_meta'] ?? {})['isReplay'] === true) return;
        if (!['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(String(update['sessionUpdate']))) return;
        if (!active || active.terminal) { this.retire(new Error('acp_content_without_active_turn')); return; }
        active.queue.enqueue(frame, active.consume);
    }
    private async drain(active: Active): Promise<void> {
        await this.bounded(Promise.all([active.queue.drain(), this.callbacks.drain(active.owner.binding.runId)]),
            this.options.drainTimeoutMs ?? 5_000, 'acp_drain_timeout');
    }
    private async bounded<T>(operation: Promise<T>, milliseconds: number, code: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { const error = new Error(code); this.retire(error); reject(error); }, milliseconds);
            })]);
        } finally { if (timer) clearTimeout(timer); }
    }
    private error(error: unknown): Error { return error instanceof Error ? error : new Error('acp_session_failed'); }
    private assertAlive(): void { if (!this.alive) throw this.failure ?? new Error('acp_retired'); }

    retire(error = new Error('acp_retired')): void {
        if (this.failure) return;
        this.failure = error; this.ready = false;
        this.active?.queue.close(error);
        this.callbacks?.dispose();
        this.connection?.close(error);
        this.owner.terminate(error.message.includes('timeout') ? 'timeout' : 'cancel');
        try { this.options.failed?.(error); } catch { /* Local retirement is already complete. */ }
    }
    async close(): Promise<void> {
        this.retire();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (this.child.exitCode === null && this.child.signalCode === null) {
                await Promise.race([this.exited, new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('acp_reap_timeout')), 6000);
                })]);
            }
        } finally { if (timer) clearTimeout(timer); this.cleanupIO(); }
    }
}
