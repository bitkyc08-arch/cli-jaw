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
    partial: string;
};
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_PARTIAL_CHARS = 1024 * 1024;
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
        tools: false, toolOutput: false, approvals: false, questions: false, images: false, subagents: false });
    readonly supportsInterrupt = true;
    private readonly input = createClaudeInput<SDKUserMessage>(32);
    private readonly processes = createClaudeProcessOwner();
    private query: ClaudeQuery | undefined;
    private reader: Promise<void> = Promise.resolve();
    private readonly exits = new Set<(code: number | null) => void>();
    private turn: Turn | null = null;
    private id = '';
    private closing = false;
    private closePromise: Promise<void> | undefined;
    private failure = false;
    private exited = false;
    private readonly registry: RuntimeRequests;

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
    get alive(): boolean { return !this.closing && !this.failure; }
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
        const turn: Turn = { context, onEvent, resolve, partial: '',
            timer: setTimeout(() => this.fail('claude_prompt_timeout'), this.options.promptTimeoutMs) };
        this.turn = turn;
        this.emit(turn, { kind: 'turn-start', provider: 'claude' });
        if (this.turn !== turn || this.closing) return result;
        if (!this.current(turn.context)) {
            this.settle({ status: 'stopped', finalText: null, partialText: '' });
            this.kill(); return result;
        }
        if (!this.input.offer({ type: 'user', uuid: randomUUID(), session_id: this.id,
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
    private emit(turn: Turn, body: RuntimeEventBody): void {
        if (!this.current(turn.context)) return;
        try {
            const event = (this.options.record ?? recordRuntimeEvent)(turn.context, body);
            if (event) turn.onEvent(event);
        } catch { console.warn('[claude-native] projection_failed'); }
    }
    private settle(outcome: RuntimeTurnResult): void {
        const turn = this.turn;
        if (!turn) return;
        this.turn = null; clearTimeout(turn.timer);
        this.registry.cancelRun(turn.context.runId);
        this.emit(turn, { kind: 'turn-end', status: outcome.status, finalText: outcome.finalText });
        turn.resolve(outcome);
    }
    private fail(_reason: string): void {
        this.failure = true;
        this.settle({ status: 'error', finalText: null, partialText: this.turn?.partial ?? '' });
        this.kill();
    }
    private async read(query: ClaudeQuery): Promise<void> {
        try {
            for await (const message of query) {
                if (this.closing) break;
                const raw = record(message);
                if (raw['parent_tool_use_id']) continue;
                if ((raw['type'] === 'system' && raw['subtype'] === 'init') || raw['type'] === 'result') {
                    const id = raw['session_id'];
                    if (typeof id === 'string' && id && id.length <= 1024) this.id = id;
                }
                const turn = this.turn;
                if (!turn) continue;
                if (!this.current(turn.context)) { this.settle({ status: 'stopped', finalText: null, partialText: turn.partial }); this.kill(); break; }
                this.accept(raw, turn);
            }
            if (!this.closing) this.fail('claude_eof');
        } catch { if (!this.closing) this.fail('claude_reader_failed'); }
        finally { this.input.close(); }
    }
    private accept(raw: Record<string, unknown>, turn: Turn): void {
        if (raw['parent_tool_use_id']) return;
        if (raw['type'] === 'assistant') {
            const message = record(raw['message']);
            if (!Array.isArray(message['content'])) throw new Error('claude_invalid_content');
            let text = '';
            for (const value of message['content'].slice(0, 512)) {
                const block = record(value);
                if (block['type'] === 'text' && typeof block['text'] === 'string') text += block['text'].slice(0, MAX_PARTIAL_CHARS - text.length);
            }
            turn.partial = text;
        } else if (raw['type'] === 'result') {
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
            const status = raw['subtype'] === 'success' && raw['is_error'] !== true ? 'done' : 'error';
            const finalText = status === 'done' && typeof raw['result'] === 'string' ? raw['result'] : null;
            this.settle({ status, finalText, partialText: turn.partial });
        }
    }
    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
        this.closePromise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
        this.closing = true;
        const partialText = this.turn?.partial ?? '';
        this.input.close();
        this.settle({ status: this.failure ? 'error' : 'stopped', finalText: null, partialText });
        let terminationError: unknown;
        try { this.query?.close(); } catch (error) { terminationError = error; }
        this.processes.terminate();
        void (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([Promise.all([this.reader, this.processes.wait()]), new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('claude_close_timeout')), this.options.closeTimeoutMs ?? 5000);
                })]);
                if (terminationError) throw new Error('claude_close_failed');
                this.exited = true;
                for (const cb of this.exits) { try { cb(this.failure ? 1 : 0); } catch { console.warn('[claude-native] exit_observer_failed'); } }
                this.exits.clear();
            } finally { if (timer) clearTimeout(timer); }
        })().then(resolveClose, rejectClose);
        return this.closePromise;
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
