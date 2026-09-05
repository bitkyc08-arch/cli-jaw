import type { RuntimeCapabilities, RuntimeEvent, RuntimeEventBody, RuntimeTurnOutcome } from '../../../shared/runtime-contract.js';
import { parseRuntimeEvent } from '../../../shared/runtime-event-parse.js';
import { FULLTEXT_MAX_CHARS } from '../../events/fulltext-bound.js';
import { recordRuntimeEvent, type RuntimeEventContext } from '../events.js';
import { RuntimeProjection, type RuntimeEnd } from '../projection.js';
import { runtimeRequests, type RuntimeRequests } from '../requests.js';
import type { NativeRuntimeSession, RuntimeInputAcceptance, RuntimePrompt } from '../session.js';
import type { AcpSession } from './session.js';
import { AcpProjection } from './projection.js';

export interface AcpRuntimeTurnContext extends RuntimeEventContext { isCurrent(): boolean }
export interface AcpRuntimeSessionOptions {
    provider: string;
    capabilities: RuntimeCapabilities;
    getTurnContext(): AcpRuntimeTurnContext;
    deferTurnEnd?: boolean;
    registry?: RuntimeRequests;
    record?: typeof recordRuntimeEvent;
    resultUsage?: (result: Record<string, unknown>) => Extract<RuntimeEventBody, { kind: 'usage' }> | null;
}
type Turn = {
    context: RuntimeEventContext;
    current(): boolean;
    projection: RuntimeProjection;
    acp: AcpProjection;
    emit(body: RuntimeEventBody): RuntimeEvent | null;
    cancelled: boolean;
};
type Pending = { turn: Turn; outcome: RuntimeTurnOutcome; claimed?: RuntimeTurnOutcome };

function snapshot(outcome: RuntimeTurnOutcome): RuntimeTurnOutcome {
    return Object.freeze({ status: outcome.status, finalText: outcome.finalText, partialText: outcome.partialText });
}
function failureCode(error: unknown): string {
    const value = error instanceof Error ? error.message : '';
    return /^(?:acp|cursor_acp)_[a-z_]+$/.test(value) ? value : 'acp_runtime_failed';
}

/** One resident protocol session; every send captures a separate immutable app turn. */
export class AcpRuntimeSession implements NativeRuntimeSession {
    readonly capabilities: RuntimeCapabilities;
    private active: Turn | null = null;
    private pending: Pending | null = null;
    private finalizing = false;
    private closing = false;
    private neutralClose = false;
    private boundOwner: { sessionId: string; scope: string } | null = null;
    private failure: string | null = null;
    private readonly registry: RuntimeRequests;

    constructor(readonly protocol: AcpSession, private readonly options: AcpRuntimeSessionOptions) {
        this.capabilities = Object.freeze({ ...options.capabilities, transport: 'native',
            steer: 'restart', questions: false, images: false, subagents: false });
        this.registry = options.registry ?? runtimeRequests;
    }
    get alive(): boolean { return !this.closing && this.protocol.alive; }
    get idle(): boolean { return this.alive && this.protocol.idle && !this.active && !this.pending && !this.finalizing; }
    get nativeSessionId(): string { return this.protocol.nativeSessionId; }
    get lastError(): string | null { return this.failure; }

    private capture(onEvent: (event: RuntimeEvent) => void): Turn {
        const source = this.options.getTurnContext();
        const { runId, sessionId, scope, turnId, audience, parentItemId } = source;
        const predicate = source.isCurrent;
        const current = () => { try { return predicate() === true; } catch { return false; } };
        const context: RuntimeEventContext = Object.freeze({ runId, sessionId, scope, turnId, audience,
            ...(parentItemId === undefined ? {} : { parentItemId }) });
        if ((audience !== 'public' && audience !== 'internal') || typeof predicate !== 'function' || !current()
            || !parseRuntimeEvent({ ...context, version: 1, seq: 1, kind: 'turn-start', provider: this.options.provider })) {
            throw new Error('acp_runtime_invalid_owner');
        }
        if (this.boundOwner && (this.boundOwner.scope !== scope || this.boundOwner.sessionId !== sessionId)) {
            throw new Error('acp_runtime_owner_changed');
        }
        const record = this.options.record ?? recordRuntimeEvent;
        let recording = true;
        const emit = (body: RuntimeEventBody): RuntimeEvent | null => {
            if (!recording) return null;
            let event: RuntimeEvent | null;
            try { event = record(context, body); } catch { event = null; }
            if (!event) { recording = false; return null; }
            try { onEvent(event); } catch { console.warn('[runtime:acp] event observer failed'); }
            return event;
        };
        const projection = new RuntimeProjection(context, (_context, body) => emit(body));
        this.boundOwner ??= { sessionId, scope };
        return { context, current, projection, acp: new AcpProjection(projection), emit, cancelled: false };
    }

    async send(prompt: RuntimePrompt, onEvent: (event: RuntimeEvent) => void): Promise<RuntimeTurnOutcome> {
        if (!this.idle) throw new Error('acp_runtime_busy');
        if (typeof prompt.text !== 'string' || prompt.text.length > FULLTEXT_MAX_CHARS || prompt.images?.length) {
            throw new Error('acp_runtime_prompt_unsupported');
        }
        const turn = this.capture(onEvent);
        this.active = turn;
        this.failure = null;
        turn.projection.start(this.options.provider);
        let outcome: RuntimeTurnOutcome;
        try {
            if (turn.cancelled || !turn.current()) throw new Error('acp_runtime_cancelled_before_prompt');
            const result = await this.protocol.prompt([{ type: 'text', text: prompt.text }], {
                binding: turn.context, isCurrent: () => this.active === turn && turn.current(),
                emit: turn.emit, ...(turn.context.parentItemId === undefined ? {} : { parentItemId: turn.context.parentItemId }),
            }, frame => { if ('method' in frame) turn.acp.update(frame.params, this.protocol.nativeSessionId); });
            if (this.options.resultUsage) {
                try {
                    const usage = this.options.resultUsage(result);
                    if (usage && !turn.emit(usage)) turn.projection.report('persistence');
                } catch { console.warn('[runtime:acp] optional usage unavailable'); }
            }
            const status = turn.cancelled || !turn.current() || result['stopReason'] === 'cancelled' ? 'stopped'
                : result['stopReason'] === 'end_turn' ? 'done' : 'error';
            const finalText = status === 'done' ? turn.acp.finalText(result) : null;
            if (status !== 'done') turn.acp.stopTools();
            if (status === 'error') this.failure = 'acp_runtime_incomplete';
            outcome = snapshot({ status, finalText, partialText: turn.acp.partialText });
        } catch (error) {
            this.failure = failureCode(error);
            turn.acp.stopTools();
            try { await this.protocol.close(); } catch { this.failure = 'acp_runtime_cleanup_failed'; }
            outcome = snapshot({ status: turn.cancelled || !turn.current() ? 'stopped' : 'error', finalText: null, partialText: turn.acp.partialText });
        } finally {
            if (this.active === turn) this.active = null;
        }
        if (this.options.deferTurnEnd) this.pending = { turn, outcome };
        else {
            this.finalizing = true;
            try { turn.projection.close({ kind: 'turn-end', status: outcome.status, finalText: outcome.finalText,
                ...(this.failure ? { error: this.failure } : {}) }); }
            finally { this.finalizing = false; }
        }
        return outcome;
    }

    claimTurnOutcome(turnId: string): RuntimeTurnOutcome | null {
        const pending = this.pending;
        if (!pending || pending.turn.context.turnId !== turnId) return null;
        if (!pending.claimed) {
            if (!this.protocol.alive && !this.neutralClose && pending.outcome.status === 'done') {
                pending.outcome = snapshot({ ...pending.outcome, status: 'error', finalText: null });
                this.failure ??= 'acp_runtime_failed';
            }
            pending.claimed = snapshot(pending.outcome);
        }
        return pending.claimed;
    }

    finalizeTurn(turnId: string, end: RuntimeEnd): boolean {
        const pending = this.pending;
        if (!pending || !pending.claimed || this.finalizing || pending.turn.context.turnId !== turnId) return false;
        if (end.kind !== 'turn-end' || !['done', 'error', 'stopped'].includes(end.status)
            || (end.finalText !== null && (typeof end.finalText !== 'string' || end.finalText.length > FULLTEXT_MAX_CHARS))
            || (end.status === 'done' && pending.claimed.status !== 'done')) return false;
        this.finalizing = true;
        this.pending = null; // retire the token before any event observer can re-enter
        try {
            pending.turn.projection.close({ kind: 'turn-end', status: end.status, finalText: end.finalText,
                ...(end.error === undefined ? {} : { error: end.error }) });
            return true;
        } finally { this.finalizing = false; }
    }

    async steer(_prompt: RuntimePrompt): Promise<RuntimeInputAcceptance> {
        const turn = this.active ?? this.pending?.turn;
        return { mode: 'restart', accepted: false, turnId: turn?.context.turnId ?? '', reason: 'Use application restart steering' };
    }

    async cancel(): Promise<void> {
        if (this.active) this.active.cancelled = true;
        if (this.pending && !this.pending.claimed) {
            this.pending.outcome = snapshot({ ...this.pending.outcome, status: 'stopped', finalText: null });
        }
        if (this.pending?.claimed) { await this.protocol.close(); return; }
        await this.protocol.cancel();
    }

    async respond(requestId: string, response: unknown): Promise<void> {
        const turn = this.active;
        if (!turn || !turn.current()) throw new Error('request_not_current');
        this.registry.respond(requestId, turn.context, response);
    }

    async close(): Promise<void> {
        if (this.pending && !this.pending.claimed && !this.protocol.alive && !this.neutralClose) {
            this.pending.outcome = snapshot({ ...this.pending.outcome, status: 'error', finalText: null });
        }
        this.closing = true;
        this.neutralClose = true;
        if (this.active) this.active.cancelled = true;
        await this.protocol.close();
    }
}
