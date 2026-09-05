import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeCapabilities, RuntimeEvent, RuntimeEventBody } from '../../shared/runtime-contract.js';
import { parseRuntimeEvent } from '../../shared/runtime-event-parse.js';
import { recordRuntimeEvent, type RuntimeEventContext } from './events.js';
import type { NativeRuntimeSession, RuntimePrompt, RuntimeTurnResult, RuntimeInputAcceptance } from './session.js';
import { runtimeRequests, type RuntimeRequests } from './requests.js';
import { createClaudeInput } from './claude-sdk-input.js';
import { buildClaudeSdkOptions, type PreparedClaudeOptions } from './claude-sdk-options.js';
import { loadClaudeSdk } from './claude-sdk-loader.js';
import { createClaudeProcessOwner } from './claude-sdk-process.js';
import { RuntimeProjection, type RuntimeEnd } from './projection.js';
import { ClaudeSdkEvents } from './claude-sdk-events.js';
import { createClaudeClose } from './claude-sdk-close.js';
import { createClaudeMetadata, type ClaudeResultMetadata } from './claude-sdk-metadata.js';
import { ClaudeSdkOwners, claudeToolIds } from './claude-sdk-owners.js';
import { createClaudePermissions } from './claude-sdk-permissions.js';
import { makeClaudeUserMessage } from './claude-sdk-content.js';
import { ClaudeSdkChildren, type ClaudeChildOwner } from './claude-sdk-children.js';
import { claudeForegroundHooks } from './claude-sdk-hooks.js';

export interface ClaudeTurnContext extends RuntimeEventContext { isCurrent(): boolean }
export type { ClaudeResultMetadata } from './claude-sdk-metadata.js';
export type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void };
export interface ClaudeSessionOptions {
    prepared: PreparedClaudeOptions;
    getTurnContext(): ClaudeTurnContext;
    promptTimeoutMs: number;
    closeTimeoutMs?: number;
    registry?: RuntimeRequests;
    signal?: AbortSignal;
    deferTurnEnd?: boolean;
    onMetadata?(context: Readonly<ClaudeTurnContext>, metadata: ClaudeResultMetadata): void;
    queryFactory?(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuery;
    record?(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null;
}
type Turn = {
    context: Readonly<ClaudeTurnContext>; onEvent(event: RuntimeEvent): void;
    resolve(result: RuntimeTurnResult): void; timer: ReturnType<typeof setTimeout>;
    mapper: ClaudeSdkEvents; projection: RuntimeProjection; uuid: ReturnType<typeof randomUUID>; offered: boolean;
    owner: ClaudeChildOwner;
    passiveFinalizing: boolean;
};
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('claude_invalid_frame');
    return value as Record<string, unknown>;
}
function validTimeout(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('claude_invalid_timeout');
}

/** A query owns one reader; each admitted send owns an immutable jaw turn binding. */
export class ClaudeSdkSession implements NativeRuntimeSession {
    readonly capabilities: RuntimeCapabilities = Object.freeze({ transport: 'native', steer: 'queued', resume: true,
        tools: true, toolOutput: true, approvals: true, questions: true, images: true, subagents: true });
    readonly supportsInterrupt = true;
    private readonly input = createClaudeInput<SDKUserMessage>(32);
    private readonly processes = createClaudeProcessOwner();
    private query: ClaudeQuery | undefined;
    private reader: Promise<void> = Promise.resolve();
    private readonly exits = new Set<(code: number | null) => void>();
    private turn: Turn | null = null;
    private pendingFinal: { turn: Turn; outcome: RuntimeTurnResult; failed?: boolean } | null = null;
    private finalizing = false;
    private id = '';
    private closing = false;
    private closeOperation: (() => Promise<void>) | undefined;
    private failure = false;
    private failureCode: string | null = null;
    private exited = false;
    private readonly registry: RuntimeRequests;
    private readonly terminalIds = new Set<string>();
    private readonly deferredTurnIds = new Set<string>();
    private readonly readMetadata = createClaudeMetadata();
    private readonly owners = new ClaudeSdkOwners();
    private readonly children = new ClaudeSdkChildren({ resolveParent: id => this.owners.parent(id) });
    private readonly permissions: ReturnType<typeof createClaudePermissions>;

    constructor(private readonly options: ClaudeSessionOptions) {
        this.registry = options.registry ?? runtimeRequests;
        this.permissions = createClaudePermissions({ registry: this.registry, permissions: options.prepared.permissions,
            resolveOwner: async id => this.alive ? this.children.resolveTool(id) ?? this.owners.resolve(id) : null });
    }
    async start(factory: NonNullable<ClaudeSessionOptions['queryFactory']>): Promise<void> {
        if (this.query || this.closing) throw new Error('claude_session_already_started');
        const options = this.options;
        const prepared = buildClaudeSdkOptions(options.prepared);
        try { this.query = factory({ prompt: this.input.stream, options: {
            ...prepared, spawnClaudeCodeProcess: value => this.processes.spawn(value),
            canUseTool: this.permissions.canUseTool,
            forwardSubagentText: true,
            hooks: claudeForegroundHooks(),
        } });
            this.reader = this.read(this.query);
        } catch (error) { this.failure = true; await this.close(); throw error; }
    }
    get alive(): boolean { return this.query !== undefined && !this.closing && !this.failure; }
    get idle(): boolean { return this.alive && this.turn === null && this.pendingFinal === null && !this.finalizing; }
    get nativeSessionId(): string { return this.id; }
    get activeProcessCount(): number { return this.processes.activeCount; }
    get stderrBytes(): number { return this.processes.stderrBytes; }
    get lastError(): string | null { return this.failureCode; }

    async send(prompt: RuntimePrompt, onEvent: (event: RuntimeEvent) => void): Promise<RuntimeTurnResult> {
        if (!this.alive) throw new Error('claude_session_closed');
        if (this.turn || this.pendingFinal || this.finalizing) throw new Error('claude_session_busy');
        const message = makeClaudeUserMessage(prompt);
        const context = Object.freeze({ ...this.options.getTurnContext() });
        if (!this.current(context)) throw new Error('claude_owner_stale');
        // Schema preflight only; the real seq is still allocated by the trace writer.
        if (!parseRuntimeEvent({ ...context, version: 1, seq: 1, kind: 'turn-start', provider: 'claude' })) {
            throw new Error('claude_invalid_context');
        }
        if (this.options.deferTurnEnd) {
            if (this.deferredTurnIds.has(context.turnId)) throw new Error('claude_turn_identity_reused');
            if (this.deferredTurnIds.size >= 512) throw new Error('claude_turn_identity_capacity');
            this.deferredTurnIds.add(context.turnId);
        }
        let resolve!: (value: RuntimeTurnResult) => void;
        const result = new Promise<RuntimeTurnResult>(yes => { resolve = yes; });
        const projection = new RuntimeProjection(context, (_context, body) => this.recordEvent(turn, body));
        const turn: Turn = { context, onEvent, resolve, projection, mapper: new ClaudeSdkEvents(projection), uuid: randomUUID(), offered: false, passiveFinalizing: false,
            owner: { context, projection, isCurrent: () => this.current(context), isActive: () => this.turn === turn && !this.closing,
                record: (ownerContext, body) => this.recordEvent(turn, body, ownerContext) },
            timer: setTimeout(() => this.fail('claude_prompt_timeout'), this.options.promptTimeoutMs) };
        this.turn = turn;
        projection.start('claude');
        if (this.turn !== turn || this.closing) return result;
        if (!this.current(turn.context)) {
            this.settle({ status: 'stopped', finalText: null, partialText: '' });
            this.kill(); return result;
        }
        turn.offered = true;
        if (!this.input.offer({ ...message, uuid: turn.uuid, session_id: this.id })) this.fail('claude_input_closed');
        return result;
    }
    async steer(_prompt: RuntimePrompt): Promise<RuntimeInputAcceptance> {
        return { accepted: false, mode: 'queued', turnId: this.turn?.context.turnId ?? '', reason: 'Use the scoped follow-up policy' };
    }
    async respond(requestId: string, response: unknown): Promise<void> {
        if (!this.turn || !this.alive) throw new Error('request_not_current');
        this.registry.respond(requestId, this.turn.context, response);
    }
    interrupt(): Promise<void> { return this.cancel(); }
    cancel(): Promise<void> {
        if (this.pendingFinal && !this.pendingFinal.failed && !this.failure) {
            this.pendingFinal.outcome = { ...this.pendingFinal.outcome, status: 'stopped', finalText: null };
        }
        return this.close();
    }
    finalizeTurn(turnId: string, end: RuntimeEnd): boolean {
        const pending = this.pendingFinal;
        if (!pending || pending.turn.context.turnId !== turnId) return false;
        if (pending.outcome.status !== 'done' && end.status === 'done') return false;
        this.pendingFinal = null;
        this.finalizing = true; pending.turn.passiveFinalizing = true;
        try { pending.turn.mapper.finish({ ...pending.outcome, status: end.status, finalText: end.finalText }, end); }
        finally { pending.turn.passiveFinalizing = false; this.finalizing = false; }
        if (this.deferredTurnIds.size >= 512) this.kill();
        return true;
    }
    getTurnOutcome(turnId: string): RuntimeTurnResult | null {
        const pending = this.pendingFinal;
        return pending?.turn.context.turnId === turnId ? { ...pending.outcome } : null;
    }
    kill(): void { void this.cancel().catch(() => console.warn('[claude-native] cleanup_failed')); }
    onExit(cb: (code: number | null) => void): () => void {
        if (this.exited) { cb(this.failure ? 1 : 0); return () => {}; }
        this.exits.add(cb); return () => { this.exits.delete(cb); };
    }
    private current(context: Readonly<ClaudeTurnContext>): boolean {
        try { return context.isCurrent() === true; } catch { return false; }
    }
    private recordEvent(turn: Turn, body: RuntimeEventBody, context: RuntimeEventContext = turn.context): RuntimeEvent | null {
        if (!turn.passiveFinalizing && !this.current(turn.context)) return null;
        try {
            const event = (this.options.record ?? recordRuntimeEvent)(context, body);
            if (event) { try { turn.onEvent(event); } catch { console.warn('[claude-native] observer_failed'); } }
            return event;
        } catch { console.warn('[claude-native] projection_failed'); return null; }
    }
    private settle(outcome: RuntimeTurnResult): void {
        const turn = this.turn;
        if (!turn) return;
        this.turn = null; clearTimeout(turn.timer);
        this.permissions.cancelAll(); this.owners.cancelPending();
        if (outcome.status !== 'done') this.children.stopOwner(turn.context);
        this.owners.retire(turn.context);
        if (this.options.deferTurnEnd) this.pendingFinal = { turn, outcome, failed: outcome.status === 'error' };
        else turn.mapper.finish(outcome, outcome.status === 'error' && this.failureCode
            ? { kind: 'turn-end', status: 'error', finalText: null, error: this.failureCode } : undefined);
        turn.resolve(outcome);
        if (this.owners.saturated || this.terminalIds.size >= 512) {
            void this.close().catch(() => console.warn('[claude-native] cleanup_failed'));
        }
    }
    private fail(reason: string): void {
        this.failureCode ??= reason;
        this.failure = true;
        if (this.pendingFinal) {
            this.pendingFinal.failed = true;
            this.pendingFinal.outcome = { ...this.pendingFinal.outcome, status: 'error', finalText: null };
        }
        this.settle({ status: 'error', finalText: null, partialText: this.turn?.mapper.partialText ?? '' });
        this.kill();
    }
    private async read(query: ClaudeQuery): Promise<void> {
        try {
            for await (const message of query) {
                if (this.closing) break;
                const raw = record(message);
                const taskPatch = raw['type'] === 'system' && raw['subtype'] === 'task_updated' ? raw['patch'] : undefined;
                const toolResult = raw['type'] === 'user' ? raw['tool_use_result'] : undefined;
                if ((raw['type'] === 'system' && raw['subtype'] === 'task_started' && raw['is_backgrounded'] === true)
                    || (taskPatch && typeof taskPatch === 'object' && Reflect.get(taskPatch, 'is_backgrounded') === true)
                    || (toolResult && typeof toolResult === 'object' && Reflect.get(toolResult, 'status') === 'async_launched')) {
                    this.fail('claude_background_tasks_unsupported'); break;
                }
                const childOwned = this.children.accept(raw);
                this.owners.resolvePending(id => this.children.resolveTool(id));
                if (childOwned) {
                    for (const id of claudeToolIds(raw)) {
                        const owner = this.children.resolveTool(id);
                        if (owner) this.owners.bind(id, owner);
                    }
                    continue;
                }
                const resultId = raw['type'] === 'result' && typeof raw['uuid'] === 'string' ? raw['uuid'] : null;
                if (resultId && resultId.length > 1024) throw new Error('claude_result_id_limit');
                if (resultId && this.terminalIds.has(resultId)) continue;
                const turn = this.turn;
                if (turn && (!this.current(turn.context) || !this.correlated(raw, turn))) {
                    this.fail('claude_owner_or_correlation_stale'); break;
                }
                if (raw['type'] === 'system' && raw['subtype'] === 'init' && this.options.prepared.permissions === 'safe'
                    && raw['permissionMode'] !== 'default') { this.fail('claude_safe_mode_not_confirmed'); break; }
                if (raw['type'] === 'system' && raw['subtype'] === 'init') {
                    const id = raw['session_id'];
                    if (typeof id === 'string' && id && id.length <= 1024) this.id = id;
                }
                if (resultId) {
                    if (this.terminalIds.size >= 512) { this.fail('claude_terminal_capacity'); break; }
                    this.terminalIds.add(resultId);
                }
                if (!turn) {
                    if (this.terminalIds.size >= 512) void this.close().catch(() => console.warn('[claude-native] cleanup_failed'));
                    continue;
                }
                // A resume/startup handshake with no consumed user turn is not
                // the answer to input that merely happened to be offered meanwhile.
                if (raw['type'] === 'result' && raw['subtype'] === 'success' && raw['is_error'] === false
                    && raw['num_turns'] === 0 && raw['user_message_uuid'] === undefined && raw['user_message_uuids'] === undefined) continue;
                for (const id of claudeToolIds(raw)) this.owners.bind(id, { context: turn.context,
                    isCurrent: () => turn.owner.isCurrent() && turn.owner.isActive(),
                    emit: body => { this.recordEvent(turn, body); } }, turn.owner);
                const result = turn.mapper.accept(raw);
                if (this.closing || this.turn !== turn) continue;
                if (!this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                if (result) {
                    const nativeId = raw['session_id'];
                    if (typeof nativeId === 'string' && nativeId && nativeId.length <= 1024) this.id = nativeId;
                    const metadata = this.readMetadata(raw, result.status === 'done', this.id);
                    try { this.options.onMetadata?.(turn.context, metadata); } catch { console.warn('[claude-native] metadata_failed'); }
                    if (this.closing || this.turn !== turn) continue;
                    if (!this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                    this.settle(result);
                }
            }
            if (!this.closing) this.fail('claude_eof');
        } catch { if (!this.closing) this.fail('claude_reader_failed'); }
        finally { this.input.close(); }
    }
    private correlated(raw: Record<string, unknown>, turn: Turn): boolean {
        if (!turn.offered) return false;
        const id = raw['user_message_uuid'], ids = raw['user_message_uuids'];
        if (ids !== undefined) {
            if (!Array.isArray(ids) || ids.length > 64 || ids.some(value => typeof value !== 'string')) return false;
            return ids.includes(turn.uuid);
        }
        return id === undefined || id === turn.uuid;
    }
    close(): Promise<void> {
        let outcome: RuntimeTurnResult;
        this.closeOperation ??= createClaudeClose({ timeoutMs: this.options.closeTimeoutMs ?? 5000,
            fence: () => {
                this.closing = true;
                outcome = { status: this.failure ? 'error' : 'stopped', finalText: null, partialText: this.turn?.mapper.partialText ?? '' };
            },
            startTermination: () => { try { this.query?.close(); } finally { this.processes.terminate(); } },
            settlePending: () => { this.input.close(); this.settle(outcome); this.permissions.cancelAll(); this.owners.close(); },
            readerDone: () => Promise.all([this.reader, this.processes.wait()]),
            onClosed: () => {
                this.exited = true;
                for (const cb of this.exits) { try { cb(this.failure ? 1 : 0); } catch { console.warn('[claude-native] exit_observer_failed'); } }
                this.exits.clear();
            },
        });
        return this.closeOperation();
    }
}

export async function createClaudeSdkSession(options: ClaudeSessionOptions): Promise<ClaudeSdkSession> {
    validTimeout(options.promptTimeoutMs); validTimeout(options.closeTimeoutMs ?? 5000);
    buildClaudeSdkOptions(options.prepared);
    if (options.signal?.aborted) throw new Error('claude_acquire_aborted');
    const factory = options.queryFactory ?? (await loadClaudeSdk()).query;
    if (options.signal?.aborted) throw new Error('claude_acquire_aborted');
    const session = new ClaudeSdkSession({ ...options, prepared: { ...options.prepared, env: { ...options.prepared.env } } });
    await session.start(factory);
    if (options.signal?.aborted) { await session.close(); throw new Error('claude_acquire_aborted'); }
    return session;
}
