import { FULLTEXT_MAX_CHARS } from '../../events/fulltext-bound.js';
import type { RuntimePrompt } from '../session.js';
import type { AcpSession, AcpTurnOwner } from './session.js';
import type { AcpProjection } from './projection.js';
import type { AcpReplacementIO, AcpReplacementResult } from './replacement.js';

export interface AcpReplacementDriver {
    readonly currentEpoch: number;
    readonly isStopped: boolean;
    readonly hasPendingReplacement: boolean;
    first(prompt: RuntimePrompt): Promise<void>;
    replace(prompt: RuntimePrompt): Promise<AcpReplacementResult>;
    stop(): Promise<void>;
}
export type AcpReplacementFactory = (io: AcpReplacementIO) => AcpReplacementDriver;
export type AcpPrepareReplacement = (instruction: string, partialText: string) => RuntimePrompt;
export type AcpApplicationReplacementResult = { accepted: true; epoch: number }
    | { accepted: false; epoch: number; reason: string };
type Result = Record<string, unknown>;
type Attempt = { epoch: number; result: Promise<Result> };
type Input = { original: RuntimePrompt; prepared?: RuntimePrompt; preparing: boolean };
interface TurnOptions {
    protocol: AcpSession;
    owner: AcpTurnOwner;
    projection: AcpProjection;
    create: AcpReplacementFactory;
    prepare?: AcpPrepareReplacement;
    result?(result: Result): void;
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
}
function rejectAsync(value: unknown): void {
    if (value !== null && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function') {
        void Promise.resolve(value).catch(() => undefined);
        throw new Error('acp_replacement_async_callback');
    }
}
function promptSnapshot(value: RuntimePrompt): RuntimePrompt {
    if (!value || typeof value.text !== 'string' || value.text.length > FULLTEXT_MAX_CHARS || value.images?.length) {
        throw new Error('acp_replacement_prompt_unsupported');
    }
    return { text: value.text };
}

/** One app turn; protocol attempts are private and never publish separate terminal events. */
export class AcpReplacementTurn {
    private readonly control: AcpReplacementDriver;
    private readonly done = deferred<Result>();
    private attempt: Attempt | null = null;
    private ready: { epoch: number; result: Result } | null = null;
    private input: Input | null = null;
    private started = false;
    private stopping = false;
    private settled = false;
    private busy = false;
    private failure: Error | null = null;

    constructor(private readonly options: TurnOptions) {
        this.control = options.create({ start: (prompt, epoch) => this.start(prompt, epoch),
            cancelAndDrain: () => this.cancelAndDrain(), retire: error => this.fail(error) });
    }
    run(prompt: RuntimePrompt): Promise<Result> {
        if (this.started) throw new Error('acp_replacement_already_started');
        this.started = true;
        void this.control.first(promptSnapshot(prompt)).catch(error => {
            if (this.stopping && !this.attempt && this.options.protocol.idle) this.finish();
            else this.fail(error);
        });
        return this.done.promise;
    }
    async steer(prompt: RuntimePrompt, onLocalDispatch?: () => void): Promise<AcpApplicationReplacementResult> {
        if (this.failure) throw this.failure;
        const captured = promptSnapshot(prompt);
        const noStart = (reason: string): AcpApplicationReplacementResult => ({ accepted: false, epoch: this.control.currentEpoch, reason });
        if (this.busy) return noStart('busy');
        if (this.settled || this.stopping || !this.attempt || this.options.protocol.idle || !this.options.protocol.alive) return noStart('not-running');
        if (!this.options.owner.isCurrent()) return noStart('not-current');
        this.busy = true; // Reserve before any control, preparation or observer can re-enter.
        this.input = { original: captured, preparing: false };
        let attempted = false;
        try {
            const result = await this.control.replace(captured);
            // Dispatch stays a wire fact; a retired app owner cannot commit its input.
            if (result.accepted && !this.options.owner.isCurrent()) throw new Error('acp_replacement_not_current');
            if (result.accepted && onLocalDispatch) {
                attempted = true;
                try { rejectAsync(onLocalDispatch()); }
                catch (cause) { throw new Error('acp_replacement_observer_failed', { cause }); }
            }
            return result;
        } catch (error) {
            // attempted is deliberately set before a potentially partial user-row commit.
            this.fail(error instanceof Error ? error : new Error(attempted ? 'acp_replacement_observer_failed' : 'acp_replacement_failed'));
            throw this.failure;
        } finally { this.busy = false; this.input = null; this.finish(); }
    }
    async cancel(): Promise<void> {
        this.stopping = true;
        try { await this.control.stop(); }
        catch (error) { this.fail(error); throw error; }
        finally { this.finish(); }
    }
    private start(prompt: RuntimePrompt, epoch: number): Promise<void> {
        if (!this.started || this.settled || this.stopping || !this.options.owner.isCurrent()) throw new Error('acp_replacement_not_current');
        const value = epoch > 1 && this.options.prepare ? this.input?.prepared : prompt;
        if (!value) throw new Error('acp_replacement_prepare_missing');
        const captured = promptSnapshot(value);
        const original = deferred<Result>(), dispatched = deferred<void>();
        this.ready = null;
        this.attempt = { epoch, result: original.promise }; // Before synchronous core callbacks.
        const result = this.options.protocol.prompt([{ type: 'text', text: captured.text }], this.options.owner, frame => {
            if (epoch !== this.control.currentEpoch) return;
            if ('method' in frame) this.options.projection.update(frame.params, this.options.protocol.nativeSessionId);
        }, { onDispatched: () => dispatched.resolve() });
        void result.then(original.resolve, error => { dispatched.reject(error); original.reject(error); });
        void original.promise.then(value => {
            try { this.options.result?.(value); } catch { console.warn('[runtime:acp] optional result observer failed'); }
            if (epoch === this.control.currentEpoch) this.ready = { epoch, result: value };
            this.finish();
        }, error => this.fail(error));
        return dispatched.promise;
    }
    private async cancelAndDrain(): Promise<void> {
        const original = this.attempt;
        await this.options.protocol.cancel();
        const result = original ? await original.result : null;
        if (!this.stopping && result?.['stopReason'] !== 'cancelled') throw new Error('acp_replacement_cancel_not_confirmed');
        if (!this.options.protocol.idle) throw new Error('acp_replacement_not_idle');
        this.options.projection.stopTools();
        const input = this.input;
        if (this.stopping || !input || input.preparing || !this.options.prepare) return;
        input.preparing = true;
        let prepared: RuntimePrompt;
        try {
            const value = this.options.prepare(input.original.text, this.options.projection.partialText);
            rejectAsync(value); prepared = promptSnapshot(value);
        } catch (cause) { throw new Error('acp_replacement_prepare_failed', { cause }); }
        if (this.stopping) return; // A synchronous preparation callback may request Stop.
        if (!this.options.owner.isCurrent() || !this.options.protocol.idle) throw new Error('acp_replacement_not_current');
        input.prepared = prepared;
    }
    private fail(error: unknown): void {
        if (!this.failure) this.failure = error instanceof Error ? error : new Error('acp_replacement_failed');
        this.options.protocol.retire(this.failure);
        this.finish();
    }
    private finish(): void {
        if (this.settled || this.busy) return;
        if (this.failure) { this.settled = true; this.done.reject(this.failure); return; }
        if (this.ready && this.ready.epoch === this.control.currentEpoch && !this.control.hasPendingReplacement) {
            this.settled = true; this.done.resolve(this.ready.result);
        } else if (this.stopping && !this.attempt) {
            this.settled = true; this.done.resolve({ stopReason: 'cancelled' });
        }
    }
}
