import type { ChildProcess } from 'node:child_process';
import type { NativeRuntimeSession, RuntimePrompt } from './runtime/session.js';
import type { RuntimeEvent, RuntimeTurnOutcome } from '../shared/runtime-contract.js';

export interface NativeRunLease {
    child: ChildProcess;
    session: NativeRuntimeSession;
    release(): void;
    /** Quarantine this exact lease synchronously, before awaiting physical close. */
    retire(reason: Error): Promise<void>;
}

export interface NativeRunHost<R> {
    prompt: RuntimePrompt;
    turnId: string;
    acquire(signal: AbortSignal): Promise<NativeRunLease>;
    isCurrent(): boolean;
    /** Must undo partial attachment itself if it throws. */
    ready(lease: NativeRunLease): void | (() => void);
    event(event: RuntimeEvent): void;
    settle(lease: NativeRunLease | null, outcome: RuntimeTurnOutcome, diagnostic: string | null): Promise<R>;
    failed(error: unknown, lease: NativeRunLease | null, outcome: RuntimeTurnOutcome): R | Promise<R>;
    finalized(): void;
}

/** Private failure boundary: callers must not retry lifecycle or inference. */
export class NativeRunFailure extends Error {
    readonly outcome: RuntimeTurnOutcome;
    constructor(outcome: RuntimeTurnOutcome, cause: unknown) {
        super('Native runtime run failed', { cause });
        this.name = 'NativeRunFailure';
        this.outcome = Object.freeze({ ...outcome });
    }
}

// Same budgets as ACP's default drain and physical reap. These bound host
// contract violations, not inference or the existing logical lifecycle.
const HOST_CLEANUP_MS = 5_000;
const RETIRE_MS = 6_000;

async function bounded<T>(operation: PromiseLike<T> | T, ms: number, stage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`native_run_${stage}_timeout`)), ms);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}

/** One logical turn, one captured lease, and one application settlement. */
export function runNativeRuntime<R>(host: NativeRunHost<R>): { done: Promise<R>; cancel(reason?: string): void } {
    const controller = new AbortController();
    const turnId = host.turnId;
    const prompt = host.prompt;
    let lease: NativeRunLease | null = null;
    let cleanup: (() => void) | undefined;
    let cancellation: Promise<void> | null = null;
    let cancelOpen = true;
    let eventsOpen = false;
    let retired = false;
    let failedAttempted = false;
    let sendResolved = false;
    let result: { value: R } | undefined;
    let outcome: RuntimeTurnOutcome = { status: 'error', finalText: null, partialText: '' };
    let diagnostic: string | null = null;
    const faults: Array<{ stage: string; error: unknown }> = [];

    function remember(stage: string, error: unknown): void {
        // Observers can throw once per frame: retain only the first per stage.
        if (!faults.some(fault => fault.stage === stage)) faults.push({ stage, error });
    }

    function failure(): NativeRunFailure {
        return new NativeRunFailure(outcome, new AggregateError(faults.map(fault => fault.error),
            faults.map(fault => fault.stage).join(', ')));
    }

    function cancel(reason = 'Native runtime cancelled'): void {
        if (!cancelOpen || controller.signal.aborted) return;
        // Abort first, so both abort listeners and session.cancel can re-enter.
        controller.abort(reason);
        const captured = lease;
        if (!captured) return;
        cancellation = Promise.resolve().then(() => bounded(captured.session.cancel(), HOST_CLEANUP_MS, 'cancel'))
            .catch(error => { remember('cancel', error); });
    }

    function stopped(): boolean {
        if (!controller.signal.aborted && host.isCurrent()) return false;
        outcome = { status: 'stopped', finalText: null, partialText: '' };
        diagnostic = 'Native runtime cancelled before prompt admission';
        if (lease) remember('admission', new Error('native_run_stale_or_cancelled_lease'));
        return true;
    }

    function event(value: RuntimeEvent): void {
        if (!eventsOpen) return;
        try {
            if (host.isCurrent()) {
                // A void-typed JS callback may still return a rejected promise.
                void Promise.resolve(host.event(value)).catch(error => { remember('event', error); });
            }
        } catch (error) { remember('event', error); }
    }

    async function infer(): Promise<void> {
        if (stopped()) return;
        lease = await host.acquire(controller.signal);
        if (stopped()) return;
        const session = lease.session;
        if (!session.claimTurnOutcome || !session.finalizeTurn) {
            throw new Error('native_run_requires_claim_and_finalize');
        }
        cleanup = host.ready(lease) || undefined;
        if (stopped()) return;
        eventsOpen = true;
        try {
            // A rejection is pre-admission misuse: never read stale session partials.
            outcome = Object.freeze({ ...await session.send(prompt, event) });
            sendResolved = true;
        } finally { eventsOpen = false; }
        if (cancellation) await cancellation;
        // No live-owner check here: passive completion survives main-slot release.
        let claimed: RuntimeTurnOutcome | null;
        try { claimed = session.claimTurnOutcome(turnId); }
        catch (error) {
            outcome = { status: 'error', finalText: null, partialText: outcome.partialText };
            throw error;
        }
        if (claimed === null) {
            outcome = { status: 'error', finalText: null, partialText: outcome.partialText };
            diagnostic = 'Native runtime outcome claim failed';
            remember('claim', new Error('native_run_outcome_claim_failed'));
        } else outcome = Object.freeze({ ...claimed });
        if (!diagnostic && faults.some(fault => fault.stage === 'event')) {
            diagnostic = 'Native runtime event observer failed';
        }
    }

    async function reportFailure(): Promise<void> {
        if (failedAttempted) return;
        failedAttempted = true;
        try {
            const value = await bounded(host.failed(failure(), lease, outcome), HOST_CLEANUP_MS, 'failed');
            // Bookkeeping cannot replace an authoritative settled result.
            if (!result) result = { value };
        } catch (error) { remember('failed', error); }
    }

    async function retire(): Promise<void> {
        if (!lease || retired) return;
        retired = true;
        try { await bounded(lease.retire(failure()), RETIRE_MS, 'retire'); }
        catch (error) { remember('retire', error); }
    }

    async function finish(): Promise<void> {
        try {
            if (cancellation) await cancellation;
        } finally {
            try {
                // Await even a promise returned across the void-typed JS boundary.
                if (cleanup) await bounded(cleanup(), HOST_CLEANUP_MS, 'cleanup');
            } catch (error) { remember('cleanup', error); }
            finally {
                // Cleanup can synchronously/reentrantly cancel. Close the gate and
                // observe its single captured operation, without an unbounded loop.
                cancelOpen = false;
                try {
                    if (cancellation) await cancellation;
                    // failed may finish pending canonical state; keep the lease
                    // held until that application work has been observed too.
                    if (faults.length) await reportFailure();
                    if (faults.length) await retire();
                } finally {
                    try { if (lease) await bounded(lease.release(), HOST_CLEANUP_MS, 'release'); }
                    catch (error) { remember('release', error); await retire(); await reportFailure(); }
                    finally {
                        try { await bounded(host.finalized(), HOST_CLEANUP_MS, 'finalized'); }
                        catch (error) { remember('finalized', error); await retire(); await reportFailure(); }
                    }
                }
            }
        }
    }

    const done = Promise.resolve().then(async () => {
        try {
            await infer();
            result = { value: await host.settle(lease, outcome, diagnostic) };
        } catch (error) {
            remember('run', error);
            if (!sendResolved && controller.signal.aborted) {
                outcome = { status: 'stopped', finalText: null, partialText: '' };
            }
            await reportFailure();
        } finally { await finish(); }
        if (faults.length) {
            // Never log raw private causes (provider text/credentials may be in them).
            try { console.warn('[native-runtime-run] failed stages:', faults.map(fault => fault.stage).join(', ')); }
            catch (error) { remember('diagnostic', error); }
        }
        if (result) return result.value;
        throw failure();
    });
    return { done, cancel };
}
