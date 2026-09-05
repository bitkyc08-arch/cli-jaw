import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeCapabilities, RuntimeEvent, RuntimeEventBody } from '../../shared/runtime-contract.js';
import { recordRuntimeEvent, type RuntimeEventContext } from './events.js';
import type { NativeRuntimeSession, RuntimePrompt, RuntimeTurnResult, RuntimeInputAcceptance } from './session.js';
import { runtimeRequests, type RuntimeRequests } from './requests.js';
import { createClaudeInput } from './claude-sdk-input.js';
import { buildClaudeSdkOptions, type PreparedClaudeOptions } from './claude-sdk-options.js';
import { loadClaudeSdk } from './claude-sdk-loader.js';
import { createClaudeProcessOwner } from './claude-sdk-process.js';
import { RuntimeProjection } from './projection.js';
import { ClaudeSdkEvents } from './claude-sdk-events.js';
import { createClaudeClose } from './claude-sdk-close.js';

export interface ClaudeTurnContext extends RuntimeEventContext { isCurrent(): boolean }
export interface ClaudeResultMetadata {
    sessionId?: string; cost?: number; turns?: number; durationMs?: number;
    tokens?: { input?: number; output?: number; cache_read?: number; cache_creation?: number };
}
export type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void };
export interface ClaudeSessionOptions {
    prepared: PreparedClaudeOptions;
    getTurnContext(): ClaudeTurnContext;
    promptTimeoutMs: number;
    closeTimeoutMs?: number;
    registry?: RuntimeRequests;
    signal?: AbortSignal;
    onMetadata?(context: Readonly<ClaudeTurnContext>, metadata: ClaudeResultMetadata): void;
    queryFactory?(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuery;
    record?(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null;
}
type Turn = {
    context: Readonly<ClaudeTurnContext>; onEvent(event: RuntimeEvent): void;
    resolve(result: RuntimeTurnResult): void; timer: ReturnType<typeof setTimeout>;
    mapper: ClaudeSdkEvents; projection: RuntimeProjection; uuid: ReturnType<typeof randomUUID>; offered: boolean;
};
const MAX_PROMPT_BYTES = 1024 * 1024;
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
        tools: true, toolOutput: true, approvals: false, questions: false, images: false, subagents: false });
    readonly supportsInterrupt = true;
    private readonly input = createClaudeInput<SDKUserMessage>(32);
    private readonly processes = createClaudeProcessOwner();
    private query: ClaudeQuery | undefined;
    private reader: Promise<void> = Promise.resolve();
    private readonly exits = new Set<(code: number | null) => void>();
    private turn: Turn | null = null;
    private id = '';
    private closing = false;
    private closeOperation: (() => Promise<void>) | undefined;
    private failure = false;
    private exited = false;
    private readonly registry: RuntimeRequests;
    private readonly terminalIds = new Set<string>();

    constructor(private readonly options: ClaudeSessionOptions) {
        this.registry = options.registry ?? runtimeRequests;
    }
    async start(factory: NonNullable<ClaudeSessionOptions['queryFactory']>): Promise<void> {
        if (this.query || this.closing) throw new Error('claude_session_already_started');
        const options = this.options;
        const prepared = buildClaudeSdkOptions(options.prepared);
        try { this.query = factory({ prompt: this.input.stream, options: {
            ...prepared, spawnClaudeCodeProcess: value => this.processes.spawn(value),
            // Until wp19 exposes live callbacks, safe requests are never auto-approved.
            canUseTool: async () => ({ behavior: 'deny', message: 'Claude native decision surface unavailable' }),
        } });
            this.reader = this.read(this.query);
        } catch (error) { this.failure = true; await this.close(); throw error; }
    }
    get alive(): boolean { return this.query !== undefined && !this.closing && !this.failure; }
    get idle(): boolean { return this.alive && this.turn === null; }
    get nativeSessionId(): string { return this.id; }
    get activeProcessCount(): number { return this.processes.activeCount; }
    get stderrBytes(): number { return this.processes.stderrBytes; }

    async send(prompt: RuntimePrompt, onEvent: (event: RuntimeEvent) => void): Promise<RuntimeTurnResult> {
        if (!this.alive) throw new Error('claude_session_closed');
        if (this.turn) throw new Error('claude_session_busy');
        if (typeof prompt.text !== 'string' || Buffer.byteLength(prompt.text) > MAX_PROMPT_BYTES) throw new Error('claude_prompt_limit');
        if (prompt.images?.length) throw new Error('claude_images_unavailable');
        const context = Object.freeze({ ...this.options.getTurnContext() });
        if (!this.current(context)) throw new Error('claude_owner_stale');
        for (const value of [context.runId, context.sessionId, context.scope, context.turnId]) {
            if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('claude_invalid_context');
        }
        let resolve!: (value: RuntimeTurnResult) => void;
        const result = new Promise<RuntimeTurnResult>(yes => { resolve = yes; });
        const projection = new RuntimeProjection(context, (_context, body) => this.recordEvent(turn, body));
        const turn: Turn = { context, onEvent, resolve, projection, mapper: new ClaudeSdkEvents(projection), uuid: randomUUID(), offered: false,
            timer: setTimeout(() => this.fail('claude_prompt_timeout'), this.options.promptTimeoutMs) };
        this.turn = turn;
        projection.start('claude');
        if (this.turn !== turn || this.closing) return result;
        if (!this.current(turn.context)) {
            this.settle({ status: 'stopped', finalText: null, partialText: '' });
            this.kill(); return result;
        }
        turn.offered = true;
        if (!this.input.offer({ type: 'user', uuid: turn.uuid, session_id: this.id,
            parent_tool_use_id: null, message: { role: 'user', content: prompt.text } })) this.fail('claude_input_closed');
        return result;
    }
    async steer(_prompt: RuntimePrompt): Promise<RuntimeInputAcceptance> {
        return { accepted: false, mode: 'queued', turnId: this.turn?.context.turnId ?? '', reason: 'Use the scoped follow-up policy' };
    }
    async respond(requestId: string, response: unknown): Promise<void> {
        if (!this.turn || !this.alive) throw new Error('request_not_current');
        this.registry.respond(requestId, this.turn.context, response);
    }
    interrupt(): Promise<void> { return this.close(); }
    cancel(): Promise<void> { return this.close(); }
    kill(): void { void this.close().catch(() => console.warn('[claude-native] cleanup_failed')); }
    onExit(cb: (code: number | null) => void): () => void {
        if (this.exited) { cb(this.failure ? 1 : 0); return () => {}; }
        this.exits.add(cb); return () => { this.exits.delete(cb); };
    }
    private current(context: Readonly<ClaudeTurnContext>): boolean {
        try { return context.isCurrent() === true; } catch { return false; }
    }
    private recordEvent(turn: Turn, body: RuntimeEventBody): RuntimeEvent | null {
        if (!this.current(turn.context)) return null;
        try {
            const event = (this.options.record ?? recordRuntimeEvent)(turn.context, body);
            if (event) { try { turn.onEvent(event); } catch { console.warn('[claude-native] observer_failed'); } }
            return event;
        } catch { console.warn('[claude-native] projection_failed'); return null; }
    }
    private settle(outcome: RuntimeTurnResult): void {
        const turn = this.turn;
        if (!turn) return;
        this.turn = null; clearTimeout(turn.timer);
        this.registry.cancelRun(turn.context.runId);
        turn.mapper.finish(outcome);
        turn.resolve(outcome);
    }
    private fail(_reason: string): void {
        this.failure = true;
        this.settle({ status: 'error', finalText: null, partialText: this.turn?.mapper.partialText ?? '' });
        this.kill();
    }
    private async read(query: ClaudeQuery): Promise<void> {
        try {
            for await (const message of query) {
                if (this.closing) break;
                const raw = record(message);
                if (raw['parent_tool_use_id']) continue;
                const resultId = raw['type'] === 'result' && typeof raw['uuid'] === 'string' ? raw['uuid'] : null;
                if (resultId && resultId.length > 1024) throw new Error('claude_result_id_limit');
                if (resultId && this.terminalIds.has(resultId)) continue;
                const turn = this.turn;
                if (turn && (!this.current(turn.context) || !this.correlated(raw, turn))) {
                    this.fail('claude_owner_or_correlation_stale'); break;
                }
                if ((raw['type'] === 'system' && raw['subtype'] === 'init') || (turn && raw['type'] === 'result')) {
                    const id = raw['session_id'];
                    if (typeof id === 'string' && id && id.length <= 1024) this.id = id;
                }
                if (resultId) {
                    if (this.terminalIds.size >= 512) this.terminalIds.delete(this.terminalIds.values().next().value!);
                    this.terminalIds.add(resultId);
                }
                if (!turn) continue;
                this.metadata(raw, turn);
                if (this.closing || this.turn !== turn) continue;
                if (!this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                const result = turn.mapper.accept(raw);
                if (this.closing || this.turn !== turn) continue;
                if (!this.current(turn.context)) { this.fail('claude_owner_stale'); break; }
                if (result) this.settle(result);
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
    private metadata(raw: Record<string, unknown>, turn: Turn): void {
        if (raw['type'] === 'result') {
            const metadata: ClaudeResultMetadata = { ...(this.id ? { sessionId: this.id } : {}) };
            for (const [wire, field] of [['total_cost_usd', 'cost'], ['num_turns', 'turns'], ['duration_ms', 'durationMs']] as const) {
                const value = raw[wire]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metadata[field] = value;
            }
            const usage = raw['usage'];
            if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
                const tokens: NonNullable<ClaudeResultMetadata['tokens']> = {};
                for (const [wire, field] of [['input_tokens', 'input'], ['output_tokens', 'output'],
                    ['cache_read_input_tokens', 'cache_read'], ['cache_creation_input_tokens', 'cache_creation']] as const) {
                    const value: unknown = Reflect.get(usage, wire);
                    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) tokens[field] = value;
                }
                if (Object.keys(tokens).length) metadata.tokens = tokens;
            }
            if (this.current(turn.context)) {
                try { this.options.onMetadata?.(turn.context, metadata); } catch { console.warn('[claude-native] metadata_failed'); }
            }
        }
    }
    close(): Promise<void> {
        let outcome: RuntimeTurnResult;
        this.closeOperation ??= createClaudeClose({ timeoutMs: this.options.closeTimeoutMs ?? 5000,
            fence: () => {
                this.closing = true;
                outcome = { status: this.failure ? 'error' : 'stopped', finalText: null, partialText: this.turn?.mapper.partialText ?? '' };
            },
            startTermination: () => { try { this.query?.close(); } finally { this.processes.terminate(); } },
            settlePending: () => { this.input.close(); this.settle(outcome); },
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
