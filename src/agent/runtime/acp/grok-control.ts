import type { RuntimePrompt } from '../session.js';

export interface GrokReplacementIO {
    /** Register synchronously; resolve after local write dispatch, never full inference. */
    start(prompt: RuntimePrompt, epoch: number): Promise<void>;
    /** Original cancelled response, callback/notification drain, prompt finally and idle. */
    cancelAndDrain(): Promise<void>;
    /** Retire the owner and settle pending dispatch promises, as AcpSession.retire does. */
    retire(error: Error): void;
}
export type GrokReplacementResult = { accepted: true; epoch: number }
    | { accepted: false; epoch: number; reason: 'not-started' | 'stopped' | 'superseded' | 'capacity' };

/** A transport fault is fatal/indeterminate, never a retryable no-start result. */
export class GrokReplacementError extends Error {
    constructor(readonly stage: 'cancel' | 'dispatch', cause: unknown) {
        super(`grok_replacement_${stage}_failed`, { cause });
        this.name = 'GrokReplacementError';
    }
}
const PENDING_REPLACEMENTS = 32;
function completion() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function copyPrompt(prompt: RuntimePrompt): RuntimePrompt {
    return { text: prompt.text, ...(prompt.images === undefined ? {} : {
        images: prompt.images.map(image => ({ mimeType: image.mimeType, data: image.data })),
    }) };
}

/** One logical turn's control ordering. The wrapper owns events and its final promise. */
export class GrokReplacement {
    private epoch = 0;
    private firstRequested = false;
    private stopped = false;
    private latestIntent = 0;
    private pendingIntent = 0;
    private pendingCount = 0;
    private tail = Promise.resolve();
    private cancellation: { epoch: number; promise: Promise<void> } | null = null;
    private stopWork: Promise<void> | null = null;
    private failure: GrokReplacementError | null = null;

    constructor(private readonly io: GrokReplacementIO) {}
    get currentEpoch(): number { return this.epoch; }
    get isStopped(): boolean { return this.stopped; }
    get hasPendingReplacement(): boolean { return this.pendingIntent !== 0; }

    async first(prompt: RuntimePrompt): Promise<void> {
        if (this.failure) throw this.failure;
        if (this.stopped) throw new Error('grok_control_stopped');
        if (this.firstRequested) throw new Error('grok_control_already_started');
        const captured = copyPrompt(prompt);
        this.firstRequested = true;
        return this.serial(async () => {
            if (this.stopped) throw this.failure ?? new Error('grok_control_stopped');
            this.epoch = 1;
            await this.dispatch(captured, this.epoch);
        });
    }

    async replace(prompt: RuntimePrompt): Promise<GrokReplacementResult> {
        if (this.failure) throw this.failure;
        if (this.stopped) return this.noStart('stopped');
        if (this.epoch === 0) return this.noStart('not-started');
        if (this.pendingCount >= PENDING_REPLACEMENTS) return this.noStart('capacity');
        const captured = copyPrompt(prompt), intent = ++this.latestIntent;
        this.pendingIntent = intent;
        this.pendingCount++;
        // Start the cancellation deadline now, even while an earlier write is held.
        const cancelled = this.cancelActive();
        try {
            return await this.serial(async () => {
                await cancelled; // Fatal cancellation cannot become a retryable no-start.
                if (this.failure) throw this.failure;
                if (this.stopped) return this.noStart('stopped');
                if (intent !== this.latestIntent) return this.noStart('superseded');
                const epoch = ++this.epoch;
                this.pendingIntent = 0;
                this.cancellation = null;
                await this.dispatch(captured, epoch);
                // A later intent cannot retract an already initiated successful dispatch.
                return { accepted: true, epoch };
            });
        } finally { this.pendingCount--; }
    }

    stop(): Promise<void> {
        if (this.stopWork) return this.stopWork;
        const done = completion();
        this.stopWork = done.promise;
        void done.promise.catch(() => undefined);
        this.stopped = true;
        this.latestIntent++;
        this.pendingIntent = 0;
        if (this.failure) { done.reject(this.failure); return done.promise; }
        // Reserve stopWork before IO: a reentrant stop receives the same completion.
        const cancelled = this.cancelActive();
        void Promise.all([cancelled, this.tail]).then(() => done.resolve(), done.reject);
        return done.promise;
    }

    private noStart(reason: Extract<GrokReplacementResult, { accepted: false }>['reason']): GrokReplacementResult {
        return { accepted: false, epoch: this.epoch, reason };
    }
    private cancelActive(): Promise<void> {
        if (this.epoch === 0) return Promise.resolve();
        if (this.cancellation?.epoch === this.epoch) return this.cancellation.promise;
        const done = completion();
        const promise = done.promise.catch(error => { throw this.fail('cancel', error); });
        void promise.catch(() => undefined);
        this.cancellation = { epoch: this.epoch, promise }; // reserve before reentrant IO
        try { void Promise.resolve(this.io.cancelAndDrain()).then(done.resolve, done.reject); }
        catch (error) { done.reject(error); }
        return promise;
    }
    private async dispatch(prompt: RuntimePrompt, epoch: number): Promise<void> {
        try { await this.io.start(prompt, epoch); }
        catch (error) { throw this.fail('dispatch', error); }
    }
    private fail(stage: GrokReplacementError['stage'], cause: unknown): GrokReplacementError {
        if (this.failure) return this.failure;
        const failure = new GrokReplacementError(stage, cause);
        this.failure = failure;
        this.stopped = true;
        this.pendingIntent = 0;
        this.latestIntent++;
        try { this.io.retire(failure); }
        catch (error) { failure.cause = new AggregateError([cause, error], 'grok_retirement_failed'); }
        return failure;
    }
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const next = this.tail.then(work);
        this.tail = next.then(() => undefined, () => undefined);
        return next;
    }
}
