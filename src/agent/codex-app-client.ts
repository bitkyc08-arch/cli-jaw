// ─── Codex AppServer JSON-RPC Client ─────────────────
// Communicates with `codex app-server --listen stdio://`
// over newline-delimited JSON-RPC (lite — no "jsonrpc" key in responses).

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

// A bogus thread/resume on codex-cli 0.146.0 returns "no rollout found for thread id ...".
const RECOVERABLE_RESUME_RE = /not found|no rollout found|unknown thread|no such thread|invalid thread|thread.*missing/i;
const TERMINAL_INTERRUPT_RACE_RE = /turn not active|already completed|no active turn|unknown turn/i;

const LEGACY_SCOPE = 'legacy/default';
const PENDING_NOTIFICATION_LIMIT = 128;
const PENDING_NOTIFICATION_TTL_MS = 5_000;

const TURN_OWNED_METHODS = new Set([
    'thread/tokenUsage/updated',
    'turn/diff/updated',
    'turn/plan/updated',
    'item/started',
    'item/autoApprovalReview/started',
    'item/autoApprovalReview/completed',
    'item/completed',
    'rawResponseItem/completed',
    'rawResponse/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/commandExecution/outputDelta',
    'item/commandExecution/terminalInteraction',
    'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated',
    'item/mcpToolCall/progress',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
    'thread/compacted',
    'model/rerouted',
    'model/verification',
    'turn/moderationMetadata',
    'model/safetyBuffering/updated',
]);

const NULLABLE_TURN_METHODS = new Set([
    'thread/goal/updated',
    'hook/started',
    'hook/completed',
]);

const THREAD_OWNED_METHODS = new Set([
    'thread/status/changed',
    'thread/archived',
    'thread/deleted',
    'thread/unarchived',
    'thread/closed',
    'thread/name/updated',
    'thread/goal/cleared',
    'thread/environment/connected',
    'thread/environment/disconnected',
    'thread/settings/updated',
    'serverRequest/resolved',
    'guardianWarning',
]);

const REALTIME_THREAD_METHODS = new Set([
    'thread/realtime/started',
    'thread/realtime/itemAdded',
    'thread/realtime/transcript/delta',
    'thread/realtime/transcript/done',
    'thread/realtime/outputAudio/delta',
    'thread/realtime/sdp',
    'thread/realtime/error',
    'thread/realtime/closed',
]);

const NULLABLE_THREAD_METHODS = new Set([
    'mcpServer/oauthLogin/completed',
    'mcpServer/startupStatus/updated',
    'warning',
]);

const REQUEST_HOST_METHODS = new Set([
    'command/exec/outputDelta',
    'process/outputDelta',
    'process/exited',
    'externalAgentConfig/import/progress',
    'externalAgentConfig/import/completed',
    'fs/changed',
    'fuzzyFileSearch/sessionUpdated',
    'fuzzyFileSearch/sessionCompleted',
]);

const PROCESS_HOST_METHODS = new Set([
    'skills/changed',
    'account/updated',
    'account/rateLimits/updated',
    'app/list/updated',
    'remoteControl/status/changed',
    'deprecationNotice',
    'configWarning',
    'windows/worldWritableWarning',
    'windowsSandbox/setupCompleted',
    'account/login/completed',
]);

const TERMINAL_NOTIFICATION_METHODS = new Set([
    'error',
    'turn/completed',
    'thread/closed',
    'thread/deleted',
]);

type EvRec = Record<string, unknown>;
type ApiMode = 'unset' | 'legacy' | 'scoped';
type LaneOperation = 'idle' | 'binding' | 'turn' | 'closing' | 'terminal';
type UnknownNotificationPolicy = 'legacy-raw' | 'diagnostic-only';

export function isRecoverableResumeError(message: string): boolean {
    return RECOVERABLE_RESUME_RE.test(message);
}

function isTerminalInterruptRaceError(err: Error): boolean {
    return TERMINAL_INTERRUPT_RACE_RE.test(err.message);
}

export interface CodexAppClientOptions {
    binary?: string;
    workDir?: string;
    env?: NodeJS.ProcessEnv;
    model?: string;
    effort?: string;
    fastMode?: boolean;
    unknownNotificationPolicy?: UnknownNotificationPolicy;
}

export interface CodexThreadOptions {
    model: string;
    effort: string;
    cwd: string;
    fastMode: boolean;
    instructions?: string;
}

type LegacyThreadOptions = Partial<CodexThreadOptions>;

export interface CodexAppNotificationOwner {
    threadId: string;
    turnId: string | null;
}

export interface CodexAppTurnHandlers {
    onNotification(
        method: string,
        params: Record<string, unknown>,
        owner?: CodexAppNotificationOwner,
    ): void;
    onStderr(text: string): void;
    onExit?(code: number | null, signal: string | null): void;
    onError?(err: Error): void;
    onInterruptFailed?(err: Error): void;
}

export interface CodexAppScopedTurnHandlers extends CodexAppTurnHandlers {
    role: 'lifecycle' | 'consumer';
}

export interface CodexAppHostNotificationHandlers {
    onNotification(method: string, params: Record<string, unknown>): void;
}

export interface CodexAppUnroutedNotification {
    method: string;
    params: Record<string, unknown>;
    reason: string;
}

type PendingOperation = {
    kind: 'binding' | 'turn';
    failure: Promise<never>;
    reject: (err: Error) => void;
    failed: Error | null;
    // A turn can finish before the request that created it returns, since the
    // notification stream and the response race. Without remembering which ids
    // already ended, the late response would rebind a turn the lane has already
    // torn down, leaving it active forever and rejecting every turn after it.
    settledTurnIds: Set<string>;
};

type ScopeThreadState = CodexThreadOptions & {
    scope: string;
    threadId: string | null;
    activeTurnId: string | null;
    pendingInterrupt: boolean;
    operation: LaneOperation;
    pendingOperation: PendingOperation | null;
};

type BufferedNotification = {
    sequence: number;
    receivedAt: number;
    method: string;
    params: EvRec;
    threadId: string | null;
    turnId: string | null;
    terminal: boolean;
    candidateScopes: Set<string>;
};

type RoutedIdentity = {
    threadId: string;
    turnId: string | null;
};

type HandoffNotification = {
    method: string;
    params: EvRec;
    owner: RoutedIdentity | undefined;
};

type NotificationHandoff = {
    consumers: number;
    replaying: boolean;
    buffer: HandoffNotification[];
};

export class CodexAppClient extends EventEmitter {
    proc: ChildProcess | null = null;

    private binary: string;
    private workDir: string;
    private spawnEnv: NodeJS.ProcessEnv;
    private legacyOptions: CodexThreadOptions;
    private unknownNotificationPolicy: UnknownNotificationPolicy;
    private apiMode: ApiMode = 'unset';
    private scopes = new Map<string, ScopeThreadState>();
    private threadToScope = new Map<string, string>();
    private turnToScope = new Map<string, string>();
    private scopeDisposers = new Map<string, Set<() => void>>();
    private pendingNotifications: BufferedNotification[] = [];
    private pendingNotificationSequence = 0;
    private pendingNotificationTimer: NodeJS.Timeout | null = null;
    private preListenerNotifications: Array<{
        method: string; params: EvRec; owner: RoutedIdentity | undefined;
    }> = [];
    private legacyListenerCount = 0;
    private scopedNotificationHandoffs = new Map<string, NotificationHandoff>();
    private hostNotificationHandoff: NotificationHandoff = {
        consumers: 0,
        replaying: false,
        buffer: [],
    };
    private readonly pendingNotificationLimit = PENDING_NOTIFICATION_LIMIT;
    private readonly pendingNotificationTtlMs = PENDING_NOTIFICATION_TTL_MS;
    private nextId = 1;
    private pending = new Map<number, {
        resolve: (result: unknown) => void;
        reject: (err: Error) => void;
    }>();
    private rl: ReadlineInterface | null = null;
    private cleaned = false;
    private terminal = false;

    constructor(options: CodexAppClientOptions = {}) {
        super();
        this.binary = options.binary || 'codex';
        this.workDir = options.workDir || process.cwd();
        this.spawnEnv = options.env || process.env;
        this.legacyOptions = {
            model: options.model || 'gpt-5.5',
            effort: options.effort || 'medium',
            cwd: this.workDir,
            fastMode: options.fastMode ?? false,
        };
        this.unknownNotificationPolicy = options.unknownNotificationPolicy ?? 'legacy-raw';
    }

    get threadId(): string | null {
        return this.getThreadId(LEGACY_SCOPE);
    }

    set threadId(id: string | null) {
        this.setApiMode('legacy');
        this.bindLegacyThreadForCompatibility(id);
    }

    get activeTurnId(): string | null {
        return this.getActiveTurnId(LEGACY_SCOPE);
    }

    set activeTurnId(id: string | null) {
        this.setApiMode('legacy');
        const state = this.ensureScope(LEGACY_SCOPE, this.legacyOptions);
        if (id) {
            this.bindTurn(LEGACY_SCOPE, id);
        } else {
            this.clearActiveTurn(state);
        }
    }

    get alive(): boolean {
        return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
    }

    getThreadId(scope: string): string | null {
        return this.scopes.get(scope)?.threadId ?? null;
    }

    getActiveTurnId(scope: string): string | null {
        return this.scopes.get(scope)?.activeTurnId ?? null;
    }

    listenTurn(handlers: CodexAppTurnHandlers): { dispose(): void };
    listenTurn(scope: string, handlers: CodexAppScopedTurnHandlers): { dispose(): void };
    listenTurn(
        scopeOrHandlers: string | CodexAppTurnHandlers,
        scopedHandlers?: CodexAppScopedTurnHandlers,
    ): { dispose(): void } {
        const legacy = typeof scopeOrHandlers !== 'string';
        const scope = legacy ? LEGACY_SCOPE : scopeOrHandlers;
        if (!legacy && !scopedHandlers) throw new Error(`Missing turn handlers for scope ${scope}`);
        const handlers: CodexAppTurnHandlers = legacy ? scopeOrHandlers : scopedHandlers!;
        this.setApiMode(legacy ? 'legacy' : 'scoped');

        const handoff = legacy ? null : this.ensureScopedNotificationHandoff(scope);
        const role = legacy ? null : scopedHandlers!.role;
        const onNotification = (
            method: string,
            params: Record<string, unknown>,
            owner?: CodexAppNotificationOwner,
        ) => {
            if (role === 'consumer' && handoff?.replaying) return;
            handlers.onNotification(method, params, owner);
        };
        const onHostNotification = (method: string, params: Record<string, unknown>) => {
            handlers.onNotification(method, params);
        };
        const onStderr = (text: string) => { handlers.onStderr(text); };
        const onExit = (code: number | null, signal: string | null) => { handlers.onExit?.(code, signal); };
        const onError = (err: Error) => { handlers.onError?.(err); };
        const onInterruptFailed = (err: Error) => { handlers.onInterruptFailed?.(err); };

        this.on(`notification:${scope}`, onNotification);
        this.on('stderr', onStderr);
        this.on('exit', onExit);
        this.on('error', onError);
        this.on(`interrupt-failed:${scope}`, onInterruptFailed);
        if (legacy) {
            this.on('host-notification', onHostNotification);
            this.on('notification', onHostNotification);
        }
        // Only the transition out of "nobody is listening" drains the queue. A
        // second concurrent listener must not receive a replay of what the first
        // one already handled.
        const wasIdle = legacy && this.legacyListenerCount === 0;
        if (legacy) this.legacyListenerCount += 1;
        const scopedConsumerWasIdle = role === 'consumer' && handoff?.consumers === 0;
        if (role === 'consumer' && handoff) handoff.consumers += 1;

        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            this.off(`notification:${scope}`, onNotification);
            this.off('stderr', onStderr);
            this.off('exit', onExit);
            this.off('error', onError);
            this.off(`interrupt-failed:${scope}`, onInterruptFailed);
            if (legacy) {
                this.off('host-notification', onHostNotification);
                this.off('notification', onHostNotification);
                // The pool reuses one client across turns, so the gap between
                // disposing this listener and attaching the next is another
                // window where notifications would otherwise reach nobody.
                this.legacyListenerCount = Math.max(0, this.legacyListenerCount - 1);
            }
            if (role === 'consumer' && handoff) {
                handoff.consumers = Math.max(0, handoff.consumers - 1);
            }
            const disposers = this.scopeDisposers.get(scope);
            disposers?.delete(dispose);
            if (disposers?.size === 0) this.scopeDisposers.delete(scope);
        };
        const disposers = this.scopeDisposers.get(scope) ?? new Set<() => void>();
        disposers.add(dispose);
        this.scopeDisposers.set(scope, disposers);

        // The handover runs a caller-supplied callback, so it happens only after
        // registration is complete and a disposer exists. A throwing handler
        // would otherwise leave the listener attached with no way to detach it,
        // and with queueing switched off for good.
        if (wasIdle && this.preListenerNotifications.length > 0) {
            const buffered = this.preListenerNotifications;
            this.preListenerNotifications = [];
            let delivered = 0;
            try {
                for (const entry of buffered) {
                    handlers.onNotification(entry.method, entry.params, entry.owner);
                    delivered += 1;
                }
            } catch (err) {
                dispose();
                // Only what the handler never saw goes back. Restoring the whole
                // batch would hand the already-delivered entries to the next
                // listener a second time. Anything that arrived while the
                // handover ran still follows them in order.
                this.preListenerNotifications = [
                    ...buffered.slice(delivered), ...this.preListenerNotifications,
                ];
                throw err;
            }
        }
        if (scopedConsumerWasIdle && handoff && handoff.buffer.length > 0) {
            this.replayNotificationHandoff(handoff, handlers.onNotification, dispose);
        }
        return { dispose };
    }

    listenHostNotifications(handlers: CodexAppHostNotificationHandlers): { dispose(): void } {
        const listener = (method: string, params: Record<string, unknown>) => {
            if (this.hostNotificationHandoff.replaying) return;
            handlers.onNotification(method, params);
        };
        this.on('host-notification', listener);
        this.on('notification', listener);
        const wasIdle = this.hostNotificationHandoff.consumers === 0;
        this.hostNotificationHandoff.consumers += 1;
        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            this.off('host-notification', listener);
            this.off('notification', listener);
            this.hostNotificationHandoff.consumers = Math.max(
                0,
                this.hostNotificationHandoff.consumers - 1,
            );
        };
        if (wasIdle && this.hostNotificationHandoff.buffer.length > 0) {
            this.replayNotificationHandoff(
                this.hostNotificationHandoff,
                handlers.onNotification,
                dispose,
            );
        }
        return { dispose };
    }

    spawn(): void {
        this.assertReusable();
        const isCmdShim = process.platform === 'win32' && !this.binary.toLowerCase().endsWith('.exe');
        this.proc = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
            cwd: this.workDir,
            env: this.spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(isCmdShim ? { shell: true } : {}),
        });

        this.rl = createInterface({ input: this.proc.stdout! });
        this.rl.on('line', (line) => this.handleLine(line));
        this.rl.on('error', () => {});

        this.proc.stderr?.on('data', (chunk: Buffer) => {
            this.emit('stderr', chunk.toString());
        });

        this.proc.on('error', (err) => { this.handleProcessError(err); });
        this.proc.on('exit', (code, signal) => { this.handleProcessExit(code, signal); });
    }

    async initialize(): Promise<unknown> {
        this.assertReusable();
        const result = await this.request('initialize', {
            clientInfo: {
                name: 'cli_jaw_codex_app_server',
                title: null,
                version: '1.0.0',
            },
            capabilities: {
                experimentalApi: true,
                optOutNotificationMethods: [
                    'remoteControl/status/changed',
                    'mcpServer/startupStatus/updated',
                ],
            },
        });
        this.notify('initialized', {});
        return result;
    }

    async startThread(options?: LegacyThreadOptions): Promise<string>;
    async startThread(scope: string, options: CodexThreadOptions): Promise<string>;
    async startThread(
        scopeOrOptions: string | LegacyThreadOptions = {},
        scopedOptions?: CodexThreadOptions,
    ): Promise<string> {
        if (typeof scopeOrOptions === 'string') {
            if (!scopedOptions) throw new Error(`Missing thread options for scope ${scopeOrOptions}`);
            this.setApiMode('scoped');
            return this.startThreadScoped(scopeOrOptions, scopedOptions);
        }
        this.setApiMode('legacy');
        return this.startThreadScoped(LEGACY_SCOPE, this.mergeLegacyOptions(scopeOrOptions));
    }

    async resumeThread(threadId: string, options?: LegacyThreadOptions): Promise<string>;
    async resumeThread(scope: string, threadId: string, options: CodexThreadOptions): Promise<string>;
    async resumeThread(
        scopeOrThreadId: string,
        threadIdOrOptions: string | LegacyThreadOptions = {},
        scopedOptions?: CodexThreadOptions,
    ): Promise<string> {
        if (typeof threadIdOrOptions === 'string') {
            if (!scopedOptions) throw new Error(`Missing thread options for scope ${scopeOrThreadId}`);
            this.setApiMode('scoped');
            return this.resumeThreadScoped(scopeOrThreadId, threadIdOrOptions, scopedOptions);
        }
        this.setApiMode('legacy');
        return this.resumeThreadScoped(
            LEGACY_SCOPE,
            scopeOrThreadId,
            this.mergeLegacyOptions(threadIdOrOptions),
        );
    }

    async startTurn(prompt: string): Promise<void>;
    async startTurn(scope: string, prompt: string): Promise<void>;
    async startTurn(scopeOrPrompt: string, scopedPrompt?: string): Promise<void> {
        if (scopedPrompt !== undefined) {
            this.setApiMode('scoped');
            return this.startTurnScoped(scopeOrPrompt, scopedPrompt);
        }
        this.setApiMode('legacy');
        return this.startTurnScoped(LEGACY_SCOPE, scopeOrPrompt);
    }

    async interruptTurn(): Promise<void>;
    async interruptTurn(scope: string): Promise<void>;
    async interruptTurn(scope?: string): Promise<void> {
        const scoped = scope !== undefined;
        this.setApiMode(scoped ? 'scoped' : 'legacy');
        const laneScope = scope ?? LEGACY_SCOPE;
        const state = this.requireScope(laneScope);
        if (!state.threadId) return;
        if (!state.activeTurnId) {
            state.pendingInterrupt = true;
            return;
        }
        await this.sendInterrupt(state, state.activeTurnId);
    }

    async closeScope(scope: string): Promise<void> {
        this.setApiMode('scoped');
        const state = this.requireScope(scope);
        if (state.operation !== 'idle' || state.activeTurnId) {
            throw new Error(`Cannot close active scope ${scope}`);
        }
        state.operation = 'closing';
        try {
            if (!this.terminal && state.threadId) {
                await this.request('thread/unsubscribe', { threadId: state.threadId }).catch(() => {});
            }
        } finally {
            this.removeScope(scope);
        }
    }

    async listModels(options: { includeHidden?: boolean } = {}): Promise<unknown[]> {
        this.assertReusable();
        const all: unknown[] = [];
        let cursor: string | null = null;
        do {
            const page = await this.request('model/list', {
                ...(cursor ? { cursor } : {}),
                ...(options.includeHidden ? { includeHidden: true } : {}),
            }) as { data?: unknown[]; nextCursor?: string | null };
            all.push(...(page.data || []));
            cursor = page.nextCursor ?? null;
        } while (cursor);
        return all;
    }

    async closeGracefully(): Promise<void> {
        try {
            if (!this.terminal) {
                const ids = new Set(
                    [...this.scopes.values()].flatMap((state) => state.threadId ? [state.threadId] : []),
                );
                await Promise.all([...ids].map((threadId) =>
                    this.request('thread/unsubscribe', { threadId }).catch(() => {})));
            }
        } catch { /* best effort */ }
        this.proc?.stdin?.end();
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { this.kill(); resolve(); }, 3_000);
            if (this.proc) {
                this.proc.once('exit', () => { clearTimeout(timer); resolve(); });
            } else {
                clearTimeout(timer);
                resolve();
            }
        });
    }

    kill(): void {
        if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGTERM');
            setTimeout(() => {
                if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
            }, 2_000);
        }
    }

    cleanup(): void {
        if (this.cleaned) return;
        this.cleaned = true;
        if (this.beginProcessDeath('Client cleanup')) this.finalizeProcessDeath();
        this.rl?.close();
        this.rl = null;
        this.removeAllListeners();
    }

    // ─── Scoped operations ───────────────────────────

    private async startThreadScoped(scope: string, options: CodexThreadOptions): Promise<string> {
        const state = this.beginScopeRebind(scope, options);
        const operation = this.beginPendingOperation(state, 'binding');
        try {
            const result = await Promise.race([
                this.request('thread/start', {
                    model: state.model,
                    approvalPolicy: 'never',
                    sandbox: 'danger-full-access',
                    cwd: state.cwd,
                    config: this.reasoningConfig(state),
                    ...(state.instructions ? { developerInstructions: state.instructions } : {}),
                }) as Promise<{ thread: { id: string } }>,
                operation.failure,
            ]);
            this.bindThread(scope, result.thread.id);
            this.throwIfOperationFailed(operation);
            state.operation = 'idle';
            return result.thread.id;
        } catch (err) {
            if (state.operation !== 'terminal') state.operation = 'idle';
            throw err;
        } finally {
            if (state.pendingOperation === operation) state.pendingOperation = null;
        }
    }

    private async resumeThreadScoped(
        scope: string,
        threadId: string,
        options: CodexThreadOptions,
    ): Promise<string> {
        const state = this.beginScopeRebind(scope, options);
        const operation = this.beginPendingOperation(state, 'binding');
        try {
            const result = await Promise.race([
                this.request('thread/resume', {
                    threadId,
                    model: state.model,
                    approvalPolicy: 'never',
                    sandbox: 'danger-full-access',
                    cwd: state.cwd,
                    config: this.reasoningConfig(state),
                    excludeTurns: true,
                    ...(state.instructions ? { developerInstructions: state.instructions } : {}),
                }) as Promise<{ thread: { id: string } }>,
                operation.failure,
            ]);
            this.bindThread(scope, result.thread.id);
            this.throwIfOperationFailed(operation);
            state.operation = 'idle';
            return result.thread.id;
        } catch (err) {
            if (state.operation !== 'terminal') state.operation = 'idle';
            throw err;
        } finally {
            if (state.pendingOperation === operation) state.pendingOperation = null;
        }
    }

    private async startTurnScoped(scope: string, prompt: string): Promise<void> {
        this.assertReusable();
        const state = this.requireScope(scope);
        if (state.operation !== 'idle') {
            throw new Error(`Scope ${scope} already has ${state.operation} operation`);
        }
        if (!state.threadId) throw new Error(`No active thread for scope ${scope}`);
        state.operation = 'turn';
        const operation = this.beginPendingOperation(state, 'turn');
        try {
            const result = await Promise.race([
                this.request('turn/start', {
                    threadId: state.threadId,
                    input: [{
                        type: 'text' as const,
                        text: prompt,
                        text_elements: [],
                    }],
                    ...(state.effort ? { effort: state.effort } : {}),
                    summary: 'detailed',
                }) as Promise<{ turn?: { id?: string } }>,
                operation.failure,
            ]);
            const turnId = result.turn?.id;
            if (!turnId) throw new Error(`turn/start returned no turn id for scope ${scope}`);
            // The notification stream may have started and finished this turn
            // while the response was still travelling. Rebinding it here would
            // make a completed turn active again and block every turn after it.
            if (operation.settledTurnIds.has(turnId)) {
                this.throwIfOperationFailed(operation);
                return;
            }
            if (state.activeTurnId && state.activeTurnId !== turnId) {
                throw new Error(
                    `turn/start response ${turnId} conflicts with active turn ${state.activeTurnId} for scope ${scope}`,
                );
            }
            if (!state.activeTurnId) this.bindTurn(scope, turnId);
            this.throwIfOperationFailed(operation);
        } catch (err) {
            // A terminal notification can end this turn and let the next one
            // start before this request settles. Cleaning up unconditionally
            // would then tear down a turn that is already running, so only the
            // operation still owned by the lane may touch its state.
            if (!this.terminal && state.pendingOperation === operation) {
                this.clearActiveTurn(state);
                state.operation = 'idle';
            }
            throw err;
        } finally {
            if (state.pendingOperation === operation) state.pendingOperation = null;
        }
    }

    // ─── Lane lifecycle ──────────────────────────────

    private beginScopeRebind(scope: string, options: CodexThreadOptions): ScopeThreadState {
        this.assertReusable();
        const current = this.scopes.get(scope);
        if (current && (current.operation !== 'idle' || current.activeTurnId)) {
            throw new Error(`Scope ${scope} already has ${current.operation} operation`);
        }
        if (current) this.clearScopeBinding(current);
        const state = current ?? this.createScope(scope, options);
        state.model = options.model;
        state.effort = options.effort;
        state.cwd = options.cwd;
        state.fastMode = options.fastMode;
        if (options.instructions !== undefined) state.instructions = options.instructions;
        else delete state.instructions;
        state.threadId = null;
        state.activeTurnId = null;
        state.pendingInterrupt = false;
        state.operation = 'binding';
        state.pendingOperation = null;
        this.scopes.set(scope, state);
        this.removeBufferedForScope(scope);
        return state;
    }

    private bindThread(scope: string, threadId: string): void {
        const state = this.requireScope(scope);
        const owner = this.threadToScope.get(threadId);
        if (owner && owner !== scope) {
            throw new Error(`Thread ${threadId} is already bound to scope ${owner}`);
        }
        if (state.threadId && state.threadId !== threadId) this.clearScopeBinding(state);
        state.threadId = threadId;
        this.threadToScope.set(threadId, scope);
        this.replayPendingForScope(scope);
    }

    private bindTurn(scope: string, turnId: string, replayPending = true): void {
        const state = this.requireScope(scope);
        if (!state.threadId) throw new Error(`No active thread for scope ${scope}`);
        const owner = this.turnToScope.get(turnId);
        if (owner && owner !== scope) {
            throw new Error(`Turn ${turnId} is already bound to scope ${owner}`);
        }
        if (state.activeTurnId && state.activeTurnId !== turnId) {
            this.turnToScope.delete(state.activeTurnId);
        }
        state.activeTurnId = turnId;
        this.turnToScope.set(turnId, scope);
        if (state.pendingInterrupt) {
            state.pendingInterrupt = false;
            void this.sendInterrupt(state, turnId).catch(() => {});
        }
        if (replayPending) this.replayPendingForScope(scope);
    }

    private clearActiveTurn(state: ScopeThreadState): void {
        // Record the id before dropping it. The turn/start response may still be
        // in flight, and it must not resurrect a turn that has already ended.
        if (state.activeTurnId && state.pendingOperation?.kind === 'turn') {
            state.pendingOperation.settledTurnIds.add(state.activeTurnId);
        }
        if (state.activeTurnId && this.turnToScope.get(state.activeTurnId) === state.scope) {
            this.turnToScope.delete(state.activeTurnId);
        }
        state.activeTurnId = null;
        state.pendingInterrupt = false;
        if (state.operation === 'turn') state.operation = 'idle';
    }

    private clearScopeBinding(state: ScopeThreadState): void {
        if (state.threadId && this.threadToScope.get(state.threadId) === state.scope) {
            this.threadToScope.delete(state.threadId);
        }
        if (state.activeTurnId && this.turnToScope.get(state.activeTurnId) === state.scope) {
            this.turnToScope.delete(state.activeTurnId);
        }
        state.threadId = null;
        state.activeTurnId = null;
        state.pendingInterrupt = false;
    }

    private removeScope(scope: string): void {
        const state = this.scopes.get(scope);
        if (state) this.clearScopeBinding(state);
        for (const dispose of [...(this.scopeDisposers.get(scope) ?? [])]) dispose();
        this.scopeDisposers.delete(scope);
        this.removeAllListeners(`notification:${scope}`);
        this.removeAllListeners(`interrupt-failed:${scope}`);
        this.removeBufferedForScope(scope);
        this.scopedNotificationHandoffs.delete(scope);
        this.scopes.delete(scope);
    }

    private bindLegacyThreadForCompatibility(threadId: string | null): void {
        const state = this.ensureScope(LEGACY_SCOPE, this.legacyOptions);
        if (!threadId) {
            this.clearScopeBinding(state);
            state.operation = 'idle';
            return;
        }
        this.clearScopeBinding(state);
        state.operation = 'idle';
        this.bindThread(LEGACY_SCOPE, threadId);
    }

    private createScope(scope: string, options: CodexThreadOptions): ScopeThreadState {
        return {
            ...options,
            scope,
            threadId: null,
            activeTurnId: null,
            pendingInterrupt: false,
            operation: 'idle',
            pendingOperation: null,
        };
    }

    private ensureScope(scope: string, options: CodexThreadOptions): ScopeThreadState {
        const current = this.scopes.get(scope);
        if (current) return current;
        const state = this.createScope(scope, options);
        this.scopes.set(scope, state);
        return state;
    }

    private requireScope(scope: string): ScopeThreadState {
        this.assertReusable();
        const state = this.scopes.get(scope);
        if (!state) throw new Error(`Unknown scope ${scope}`);
        if (state.operation === 'terminal') throw new Error(`Scope ${scope} is terminal`);
        return state;
    }

    private beginPendingOperation(
        state: ScopeThreadState,
        kind: PendingOperation['kind'],
    ): PendingOperation {
        let reject!: (err: Error) => void;
        const failure = new Promise<never>((_resolve, rejectPromise) => {
            reject = rejectPromise;
        });
        const operation: PendingOperation = {
            kind, failure, reject, failed: null, settledTurnIds: new Set(),
        };
        state.pendingOperation = operation;
        return operation;
    }

    private failPendingOperation(scope: string, err: Error): boolean {
        const state = this.scopes.get(scope);
        const operation = state?.pendingOperation;
        if (!state || !operation || operation.failed) return false;
        operation.failed = err;
        operation.reject(err);
        return true;
    }

    private throwIfOperationFailed(operation: PendingOperation): void {
        if (operation.failed) throw operation.failed;
    }

    private setApiMode(mode: Exclude<ApiMode, 'unset'>): void {
        if (this.apiMode === 'unset') {
            this.apiMode = mode;
            // Host notifications can arrive during initialize, before the first
            // lane establishes the mode. Keep only the handoff owned by the mode
            // that won so the other facade cannot retain payloads forever.
            if (mode === 'scoped') {
                this.preListenerNotifications = [];
            } else {
                this.hostNotificationHandoff.buffer = [];
            }
            return;
        }
        if (this.apiMode !== mode) {
            throw new Error(`Cannot mix ${mode} Codex App API with ${this.apiMode} API`);
        }
    }

    private assertReusable(): void {
        if (this.terminal) throw new Error('Codex App client is terminal');
    }

    // ─── Notification routing ────────────────────────

    private routeNotification(method: string, params: EvRec, allowBuffer = true): void {
        this.expirePendingNotifications();
        if (method === 'error') {
            this.routeError(params, allowBuffer);
            return;
        }
        if (method === 'turn/started' || method === 'turn/completed') {
            this.routeTurnLifecycle(method, params, allowBuffer);
            return;
        }
        if (TURN_OWNED_METHODS.has(method)) {
            this.routeTurnOwned(method, params, allowBuffer);
            return;
        }
        if (NULLABLE_TURN_METHODS.has(method)) {
            this.routeNullableTurn(method, params, allowBuffer);
            return;
        }
        if (method === 'thread/started') {
            this.routeThreadStarted(params, allowBuffer);
            return;
        }
        if (THREAD_OWNED_METHODS.has(method) || REALTIME_THREAD_METHODS.has(method)) {
            this.routeThreadOwned(method, params, allowBuffer);
            return;
        }
        if (NULLABLE_THREAD_METHODS.has(method)) {
            this.routeNullableThread(method, params, allowBuffer);
            return;
        }
        if (REQUEST_HOST_METHODS.has(method) || PROCESS_HOST_METHODS.has(method)) {
            this.emitHostNotification(method, params);
            return;
        }
        this.emitUnrouted(method, params, 'unknown-method');
        if (this.unknownNotificationPolicy === 'legacy-raw') {
            this.recordPreListenerNotification(method, params, undefined);
            this.recordHostNotification(method, params);
            this.emit('notification', method, params);
        }
    }

    private routeError(params: EvRec, allowBuffer: boolean): void {
        const threadId = this.stringField(params, 'threadId');
        const turnId = this.stringField(params, 'turnId');
        if (!threadId || !turnId) {
            this.emitHostNotification('error', params);
            this.emit('server-error', params);
            return;
        }
        const scope = this.resolveTurnOwner(threadId, turnId);
        if (!scope) {
            if (allowBuffer && this.shouldBufferTurn(threadId)) {
                this.bufferNotification('error', params, threadId, turnId);
            } else {
                this.emitUnrouted('error', params, 'turn-owner-mismatch');
            }
            return;
        }
        this.emitLaneNotification(scope, 'error', params, { threadId, turnId });
        if (params['willRetry'] !== true) {
            const state = this.scopes.get(scope);
            if (state) this.clearActiveTurn(state);
        }
    }

    private routeTurnLifecycle(method: string, params: EvRec, allowBuffer: boolean): void {
        const threadId = this.stringField(params, 'threadId');
        const turn = this.recordField(params, 'turn');
        const turnId = turn ? this.stringField(turn, 'id') : null;
        if (!threadId || !turnId) {
            this.emitUnrouted(method, params, 'malformed-turn-lifecycle');
            return;
        }
        if (method === 'turn/started') {
            const threadScope = this.threadToScope.get(threadId);
            const state = threadScope ? this.scopes.get(threadScope) : undefined;
            if (
                threadScope
                && state?.threadId === threadId
                && (state.operation === 'turn' || state.pendingInterrupt)
                && (!state.activeTurnId || state.activeTurnId === turnId)
            ) {
                if (state.operation === 'idle') state.operation = 'turn';
                if (!state.activeTurnId) this.bindTurn(threadScope, turnId, allowBuffer);
                if (this.resolveTurnOwner(threadId, turnId) === threadScope) {
                    this.emitLaneNotification(threadScope, method, params, { threadId, turnId });
                }
                return;
            }
            if (allowBuffer && this.shouldBufferTurn(threadId)) {
                this.bufferNotification(method, params, threadId, turnId);
            } else {
                this.emitUnrouted(method, params, 'turn-start-owner-mismatch');
            }
            return;
        }
        const scope = this.resolveTurnOwner(threadId, turnId);
        if (!scope) {
            if (allowBuffer && this.shouldBufferTurn(threadId)) {
                this.bufferNotification(method, params, threadId, turnId);
            } else {
                this.emitUnrouted(method, params, 'turn-complete-owner-mismatch');
            }
            return;
        }
        this.emitLaneNotification(scope, method, params, { threadId, turnId });
        const state = this.scopes.get(scope);
        if (state) this.clearActiveTurn(state);
    }

    private routeTurnOwned(method: string, params: EvRec, allowBuffer: boolean): void {
        const threadId = this.stringField(params, 'threadId');
        const turnId = this.stringField(params, 'turnId');
        if (!threadId || !turnId) {
            this.emitUnrouted(method, params, 'malformed-turn-owner');
            return;
        }
        const scope = this.resolveTurnOwner(threadId, turnId);
        if (scope) {
            this.emitLaneNotification(scope, method, params, { threadId, turnId });
            return;
        }
        if (allowBuffer && this.shouldBufferTurn(threadId)) {
            this.bufferNotification(method, params, threadId, turnId);
        } else {
            this.emitUnrouted(method, params, 'turn-owner-mismatch');
        }
    }

    private routeNullableTurn(method: string, params: EvRec, allowBuffer: boolean): void {
        const threadId = this.stringField(params, 'threadId');
        if (!threadId || !Object.hasOwn(params, 'turnId')) {
            this.emitUnrouted(method, params, 'malformed-nullable-turn-owner');
            return;
        }
        if (params['turnId'] === null) {
            this.routeThreadIdentity(method, params, threadId, allowBuffer);
            return;
        }
        const turnId = this.stringField(params, 'turnId');
        if (!turnId) {
            this.emitUnrouted(method, params, 'malformed-nullable-turn-owner');
            return;
        }
        const scope = this.resolveTurnOwner(threadId, turnId);
        if (scope) {
            this.emitLaneNotification(scope, method, params, { threadId, turnId });
        } else if (allowBuffer && this.shouldBufferTurn(threadId)) {
            this.bufferNotification(method, params, threadId, turnId);
        } else {
            this.emitUnrouted(method, params, 'turn-owner-mismatch');
        }
    }

    private routeThreadStarted(params: EvRec, allowBuffer: boolean): void {
        const thread = this.recordField(params, 'thread');
        const threadId = thread ? this.stringField(thread, 'id') : null;
        if (!threadId) {
            this.emitUnrouted('thread/started', params, 'malformed-thread-lifecycle');
            return;
        }
        this.routeThreadIdentity('thread/started', params, threadId, allowBuffer);
    }

    private routeThreadOwned(method: string, params: EvRec, allowBuffer: boolean): void {
        const threadId = this.stringField(params, 'threadId');
        if (!threadId) {
            this.emitUnrouted(method, params, 'malformed-thread-owner');
            return;
        }
        this.routeThreadIdentity(method, params, threadId, allowBuffer);
    }

    private routeThreadIdentity(
        method: string,
        params: EvRec,
        threadId: string,
        allowBuffer: boolean,
    ): void {
        const scope = this.threadToScope.get(threadId);
        const state = scope ? this.scopes.get(scope) : undefined;
        if (scope && state?.threadId === threadId) {
            this.emitLaneNotification(scope, method, params, { threadId, turnId: null });
            if (method === 'thread/closed' || method === 'thread/deleted') {
                const pendingKind = state.pendingOperation?.kind;
                this.clearScopeBinding(state);
                if (state.operation !== 'terminal') state.operation = 'idle';
                if (pendingKind) {
                    this.failPendingOperation(
                        scope,
                        new Error(`Thread ${threadId} ${method === 'thread/closed' ? 'closed' : 'was deleted'} during ${pendingKind}`),
                    );
                }
            }
            return;
        }
        if (allowBuffer && this.hasPendingBinding()) {
            this.bufferNotification(method, params, threadId, null);
        } else {
            this.emitUnrouted(method, params, 'thread-owner-mismatch');
        }
    }

    private routeNullableThread(method: string, params: EvRec, allowBuffer: boolean): void {
        if (!Object.hasOwn(params, 'threadId')) {
            this.emitUnrouted(method, params, 'malformed-nullable-thread-owner');
            return;
        }
        if (params['threadId'] === null) {
            this.emitHostNotification(method, params);
            return;
        }
        const threadId = this.stringField(params, 'threadId');
        if (!threadId) {
            this.emitUnrouted(method, params, 'malformed-nullable-thread-owner');
            return;
        }
        this.routeThreadIdentity(method, params, threadId, allowBuffer);
    }

    private resolveTurnOwner(threadId: string, turnId: string): string | null {
        const threadScope = this.threadToScope.get(threadId);
        const turnScope = this.turnToScope.get(turnId);
        if (!threadScope || threadScope !== turnScope) return null;
        const state = this.scopes.get(threadScope);
        if (state?.threadId !== threadId || state.activeTurnId !== turnId) return null;
        return threadScope;
    }

    private shouldBufferTurn(threadId: string): boolean {
        const scope = this.threadToScope.get(threadId);
        if (!scope) return false;
        const state = this.scopes.get(scope);
        return state?.threadId === threadId
            && state.operation === 'turn'
            && state.pendingOperation?.kind === 'turn';
    }

    private emitLaneNotification(
        scope: string,
        method: string,
        params: EvRec,
        owner: RoutedIdentity,
    ): void {
        if (scope === LEGACY_SCOPE) {
            this.recordPreListenerNotification(method, params, owner);
        } else {
            this.recordScopedNotification(scope, method, params, owner);
        }
        this.emit(`notification:${scope}`, method, params, owner);
        if (scope === LEGACY_SCOPE && (method === 'turn/started' || method === 'turn/completed')) {
            this.emit(method, params);
        }
    }

    private emitHostNotification(method: string, params: EvRec): void {
        this.recordPreListenerNotification(method, params, undefined);
        this.recordHostNotification(method, params);
        this.emit('host-notification', method, params);
    }

    private emitUnrouted(method: string, params: EvRec, reason: string): void {
        this.emit('unrouted-notification', { method, params, reason });
    }

    // The pool starts a thread and drains the replay buffer before it hands the
    // lease back, and spawn only attaches its listener afterwards. Anything the
    // server sent in between would otherwise be emitted to nobody and never
    // reach the raw trace, so the legacy lane keeps a bounded copy and hands it
    // to the first listener exactly once.
    private recordPreListenerNotification(
        method: string,
        params: EvRec,
        owner: RoutedIdentity | undefined,
    ): void {
        // Only the legacy facade drains this queue, so filling it in scoped mode
        // would retain payloads nothing can ever hand over.
        if (this.apiMode === 'scoped' || this.legacyListenerCount > 0) return;
        if (this.preListenerNotifications.length >= PENDING_NOTIFICATION_LIMIT) {
            const evicted = this.preListenerNotifications.shift();
            // Report what was actually lost, not what pushed it out.
            if (evicted) {
                this.emit('unrouted-notification', {
                    method: evicted.method, params: evicted.params, reason: 'pre-listener-overflow',
                });
            }
        }
        this.preListenerNotifications.push({ method, params, owner });
    }

    private ensureScopedNotificationHandoff(scope: string): NotificationHandoff {
        const current = this.scopedNotificationHandoffs.get(scope);
        if (current) return current;
        const handoff: NotificationHandoff = { consumers: 0, replaying: false, buffer: [] };
        this.scopedNotificationHandoffs.set(scope, handoff);
        return handoff;
    }

    private recordScopedNotification(
        scope: string,
        method: string,
        params: EvRec,
        owner: RoutedIdentity,
    ): void {
        const handoff = this.ensureScopedNotificationHandoff(scope);
        if (handoff.consumers > 0 && !handoff.replaying) return;
        this.bufferHandoffNotification(handoff, { method, params, owner });
    }

    private recordHostNotification(method: string, params: EvRec): void {
        if (this.apiMode === 'legacy') return;
        const handoff = this.hostNotificationHandoff;
        if (handoff.consumers > 0 && !handoff.replaying) return;
        this.bufferHandoffNotification(
            handoff,
            { method, params, owner: undefined },
            this.apiMode === 'scoped',
        );
    }

    private bufferHandoffNotification(
        handoff: NotificationHandoff,
        entry: HandoffNotification,
        diagnoseOverflow = true,
    ): void {
        if (handoff.buffer.length >= this.pendingNotificationLimit) {
            const evicted = handoff.buffer.shift();
            if (evicted && diagnoseOverflow) {
                this.emitUnrouted(evicted.method, evicted.params, 'pre-listener-overflow');
            }
        }
        handoff.buffer.push(entry);
    }

    private replayNotificationHandoff(
        handoff: NotificationHandoff,
        deliver: CodexAppTurnHandlers['onNotification'],
        dispose: () => void,
    ): void {
        handoff.replaying = true;
        try {
            while (handoff.buffer.length > 0) {
                const entry = handoff.buffer.shift()!;
                try {
                    deliver(entry.method, entry.params, entry.owner);
                } catch (err) {
                    if (handoff.buffer.length >= this.pendingNotificationLimit) {
                        const evicted = handoff.buffer.shift();
                        if (evicted) {
                            this.emitUnrouted(
                                evicted.method,
                                evicted.params,
                                'pre-listener-overflow',
                            );
                        }
                    }
                    handoff.buffer.unshift(entry);
                    dispose();
                    throw err;
                }
            }
        } finally {
            handoff.replaying = false;
        }
    }

    // ─── Bounded pending notification replay ─────────

    private bufferNotification(
        method: string,
        params: EvRec,
        threadId: string | null,
        turnId: string | null,
    ): void {
        this.expirePendingNotifications();
        const terminal = TERMINAL_NOTIFICATION_METHODS.has(method);
        if (this.pendingNotifications.length >= this.pendingNotificationLimit) {
            const oldestNonTerminal = this.pendingNotifications.findIndex((entry) => !entry.terminal);
            if (oldestNonTerminal >= 0) {
                const [evicted] = this.pendingNotifications.splice(oldestNonTerminal, 1);
                if (evicted) this.diagnoseBuffered(evicted, 'capacity-evicted');
            } else if (terminal) {
                this.failBufferedOperation(
                    this.makeBufferedNotification(method, params, threadId, turnId, terminal),
                    'capacity-terminal-full',
                );
                return;
            } else {
                this.emitUnrouted(method, params, 'capacity-terminal-reserved');
                return;
            }
        }
        this.pendingNotifications.push(
            this.makeBufferedNotification(method, params, threadId, turnId, terminal),
        );
        this.schedulePendingExpiry();
    }

    private makeBufferedNotification(
        method: string,
        params: EvRec,
        threadId: string | null,
        turnId: string | null,
        terminal: boolean,
    ): BufferedNotification {
        const candidateScopes = new Set<string>();
        if (threadId) {
            const scope = this.threadToScope.get(threadId);
            if (scope) candidateScopes.add(scope);
        }
        if (candidateScopes.size === 0) {
            for (const state of this.scopes.values()) {
                if (state.pendingOperation) candidateScopes.add(state.scope);
            }
        }
        return {
            sequence: this.pendingNotificationSequence++,
            receivedAt: Date.now(),
            method,
            params,
            threadId,
            turnId,
            terminal,
            candidateScopes,
        };
    }

    private replayPendingForScope(scope: string): void {
        this.expirePendingNotifications();
        const state = this.scopes.get(scope);
        if (!state?.threadId) return;
        const replay = this.pendingNotifications
            .filter((entry) => {
                if (entry.threadId !== state.threadId) return false;
                if (!entry.turnId) return true;
                return entry.method === 'turn/started' || entry.turnId === state.activeTurnId;
            })
            .sort((a, b) => a.sequence - b.sequence);
        if (replay.length === 0) return;
        const replayed = new Set(replay);
        this.pendingNotifications = this.pendingNotifications.filter((entry) => !replayed.has(entry));
        for (const entry of replay) this.routeNotification(entry.method, entry.params, false);
        this.schedulePendingExpiry();
    }

    private expirePendingNotifications(): void {
        if (this.pendingNotifications.length === 0) {
            this.clearPendingTimer();
            return;
        }
        const cutoff = Date.now() - this.pendingNotificationTtlMs;
        const expired = this.pendingNotifications.filter((entry) => entry.receivedAt <= cutoff);
        if (expired.length === 0) return;
        const expiredSet = new Set(expired);
        this.pendingNotifications = this.pendingNotifications.filter((entry) => !expiredSet.has(entry));
        for (const entry of expired) {
            if (entry.terminal) this.failBufferedOperation(entry, 'ttl-terminal-expired');
            else this.diagnoseBuffered(entry, 'ttl-expired');
        }
        this.schedulePendingExpiry();
    }

    private schedulePendingExpiry(): void {
        this.clearPendingTimer();
        if (this.pendingNotifications.length === 0) return;
        const oldest = Math.min(...this.pendingNotifications.map((entry) => entry.receivedAt));
        const delay = Math.max(0, oldest + this.pendingNotificationTtlMs - Date.now());
        this.pendingNotificationTimer = setTimeout(() => {
            this.pendingNotificationTimer = null;
            this.expirePendingNotifications();
            this.schedulePendingExpiry();
        }, delay);
        this.pendingNotificationTimer.unref();
    }

    private clearPendingTimer(): void {
        if (!this.pendingNotificationTimer) return;
        clearTimeout(this.pendingNotificationTimer);
        this.pendingNotificationTimer = null;
    }

    private failBufferedOperation(entry: BufferedNotification, reason: string): void {
        const error = new Error(
            `Pending Codex notification ${entry.method} could not be preserved (${reason})`,
        );
        let failed = false;
        for (const scope of entry.candidateScopes) {
            failed = this.failPendingOperation(scope, error) || failed;
        }
        if (!failed) {
            for (const state of this.scopes.values()) {
                if (state.pendingOperation) {
                    failed = this.failPendingOperation(state.scope, error) || failed;
                }
            }
        }
        this.diagnoseBuffered(entry, failed ? reason : `${reason}-no-operation`);
    }

    private diagnoseBuffered(entry: BufferedNotification, reason: string): void {
        this.emitUnrouted(entry.method, entry.params, reason);
    }

    private removeBufferedForScope(scope: string): void {
        this.pendingNotifications = this.pendingNotifications.filter((entry) => {
            entry.candidateScopes.delete(scope);
            return entry.candidateScopes.size > 0;
        });
        this.schedulePendingExpiry();
    }

    private hasPendingBinding(): boolean {
        return [...this.scopes.values()].some((state) => state.pendingOperation?.kind === 'binding');
    }

    // ─── Transport and process lifecycle ─────────────

    private rejectAllPending(reason: string): void {
        if (this.pending.size === 0) return;
        const err = new Error(reason);
        for (const handler of this.pending.values()) handler.reject(err);
        this.pending.clear();
    }

    private request(method: string, params: Record<string, unknown>): Promise<unknown> {
        this.assertReusable();
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            if (!this.trySend({ jsonrpc: '2.0', id, method, params })) {
                this.pending.delete(id);
                reject(new Error('stdin not writable'));
            }
        });
    }

    private notify(method: string, params: Record<string, unknown>): void {
        this.trySend({ jsonrpc: '2.0', method, params });
    }

    private trySend(msg: Record<string, unknown>): boolean {
        const stdin = this.proc?.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) return false;
        try {
            stdin.write(JSON.stringify(msg) + '\n');
            return true;
        } catch {
            return false;
        }
    }

    private reasoningConfig(state: ScopeThreadState): Record<string, unknown> {
        return {
            ...(state.effort ? { model_reasoning_effort: state.effort } : {}),
            model_reasoning_summary: 'detailed',
            hide_agent_reasoning: false,
            show_raw_agent_reasoning: true,
            service_tier: state.fastMode ? 'fast' : 'default',
        };
    }

    private handleLine(line: string): void {
        if (!line.trim()) return;
        let msg: EvRec;
        try {
            msg = JSON.parse(line) as EvRec;
        } catch {
            this.emit('parse_error', line);
            return;
        }

        const id = msg['id'];
        const method = typeof msg['method'] === 'string' ? msg['method'] : null;
        if (id != null && typeof id === 'number' && this.pending.has(id)) {
            const handler = this.pending.get(id)!;
            this.pending.delete(id);
            const error = this.recordField(msg, 'error');
            if (error) {
                handler.reject(new Error(
                    `JSON-RPC error ${String(error['code'] ?? '')}: ${String(error['message'] ?? '')}`,
                ));
            } else {
                handler.resolve(msg['result']);
            }
            return;
        }

        if (id != null && method) {
            this.handleServerRequest(
                typeof id === 'number' || typeof id === 'string' ? id : String(id),
                method,
                this.recordField(msg, 'params') ?? {},
            );
            return;
        }

        if (method) {
            this.routeNotification(method, this.recordField(msg, 'params') ?? {});
        }
    }

    private handleServerRequest(id: number | string, method: string, params: EvRec): void {
        console.log(`[codex-app] server request: ${method} (id=${id}) — auto-declining`);
        this.emit('server_request', method, params, id);

        const declineResponses: Record<string, unknown> = {
            'item/commandExecution/requestApproval': { decision: 'decline' },
            'item/fileChange/requestApproval': { decision: 'decline' },
            'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
            'mcpServer/elicitation/request': { action: 'decline', content: null },
            'item/tool/requestUserInput': { answers: {} },
            'execCommandApproval': { decision: 'denied' },
            'applyPatchApproval': { decision: 'denied' },
        };

        const result = declineResponses[method] || {};
        this.trySend({ jsonrpc: '2.0', id, result });
    }

    private async sendInterrupt(state: ScopeThreadState, turnId: string): Promise<void> {
        try {
            await this.request('turn/interrupt', { threadId: state.threadId!, turnId });
        } catch (err) {
            const error = err as Error;
            if (isTerminalInterruptRaceError(error)) return;
            this.emit(`interrupt-failed:${state.scope}`, error);
            if (state.scope === LEGACY_SCOPE) this.emit('interrupt-failed', error);
            throw error;
        }
    }

    private handleProcessError(err: Error): void {
        if (!this.beginProcessDeath(`Process error: ${err.message}`)) return;
        try {
            this.emit('error', err);
        } finally {
            this.finalizeProcessDeath();
        }
    }

    private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (!this.beginProcessDeath('Process exited')) return;
        try {
            this.emit('exit', code, signal);
        } finally {
            this.finalizeProcessDeath();
        }
    }

    private beginProcessDeath(reason: string): boolean {
        if (this.terminal) return false;
        this.terminal = true;
        this.rejectAllPending(reason);
        const error = new Error(reason);
        for (const state of this.scopes.values()) {
            if (state.pendingOperation && !state.pendingOperation.failed) {
                state.pendingOperation.failed = error;
                state.pendingOperation.reject(error);
            }
            state.operation = 'terminal';
        }
        return true;
    }

    private finalizeProcessDeath(): void {
        for (const scope of [...this.scopes.keys()]) this.removeScope(scope);
        this.threadToScope.clear();
        this.turnToScope.clear();
        this.pendingNotifications = [];
        // Nothing will ever attach to drain these once the process is gone.
        this.preListenerNotifications = [];
        this.scopedNotificationHandoffs.clear();
        this.hostNotificationHandoff = { consumers: 0, replaying: false, buffer: [] };
        this.clearPendingTimer();
        this.scopeDisposers.clear();
        this.legacyListenerCount = 0;
        this.removeAllListeners();
    }

    private mergeLegacyOptions(options: LegacyThreadOptions): CodexThreadOptions {
        return {
            model: options.model ?? this.legacyOptions.model,
            effort: options.effort ?? this.legacyOptions.effort,
            cwd: options.cwd ?? this.legacyOptions.cwd,
            fastMode: options.fastMode ?? this.legacyOptions.fastMode,
            ...(options.instructions ? { instructions: options.instructions } : {}),
        };
    }

    private stringField(record: EvRec, key: string): string | null {
        const value = record[key];
        return typeof value === 'string' && value.length > 0 ? value : null;
    }

    private recordField(record: EvRec, key: string): EvRec | null {
        const value = record[key];
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value as EvRec
            : null;
    }
}
