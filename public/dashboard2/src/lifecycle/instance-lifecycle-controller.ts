import type { DashboardInstance } from '../../../../src/manager/types.ts';

export const INSTANCE_LIFECYCLE_DEADLINE_MS = 10_000;
export const INSTANCE_LIFECYCLE_MAX_ATTEMPTS = 40;
export const INSTANCE_LIFECYCLE_POLL_DELAY_MS = 250;

export type InstanceLifecycleExpectedState = 'online' | 'offline';
export type InstanceLifecyclePhase =
    | 'idle'
    | 'polling'
    | 'online'
    | 'offline'
    | 'error'
    | 'timed-out'
    | 'aborted';

export interface InstanceLifecycleSnapshot {
    generation: number;
    phase: InstanceLifecyclePhase;
    port: number | null;
    expectedState: InstanceLifecycleExpectedState | null;
    attempts: number;
    startedAt: number | null;
    deadlineAt: number | null;
    instance: DashboardInstance | null;
    lastError: string | null;
}

export interface InstanceLifecycleClock {
    now(): number;
}

export interface InstanceLifecycleScheduler {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export type InstanceLifecycleFetch = (
    port: number,
    options: { signal: AbortSignal },
) => Promise<DashboardInstance | null>;

export interface InstanceLifecycleControllerOptions {
    fetchInstance: InstanceLifecycleFetch;
    clock?: InstanceLifecycleClock;
    scheduler?: InstanceLifecycleScheduler;
    deadlineMs?: number;
    maxAttempts?: number;
    pollDelayMs?: number;
    onPhase?: (phase: InstanceLifecyclePhase, snapshot: InstanceLifecycleSnapshot) => void;
    onSnapshot?: (snapshot: InstanceLifecycleSnapshot) => void;
    shouldRetryError?: (error: unknown) => boolean;
}

export interface StartInstanceLifecycleOptions {
    port: number;
    expectedState: InstanceLifecycleExpectedState;
}

interface ActiveOperation {
    generation: number;
    port: number;
    expectedState: InstanceLifecycleExpectedState;
    startedAt: number;
    deadlineAt: number;
    abortController: AbortController;
    wakePending: boolean;
    interruptDelay: (() => void) | null;
}

type FetchOutcome =
    | { kind: 'result'; instance: DashboardInstance | null }
    | { kind: 'error'; error: unknown }
    | { kind: 'deadline' }
    | { kind: 'aborted' };

const browserClock: InstanceLifecycleClock = { now: () => Date.now() };
const browserScheduler: InstanceLifecycleScheduler = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const IDLE_SNAPSHOT: InstanceLifecycleSnapshot = {
    generation: 0,
    phase: 'idle',
    port: null,
    expectedState: null,
    attempts: 0,
    startedAt: null,
    deadlineAt: null,
    instance: null,
    lastError: null,
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hasConverged(
    instance: DashboardInstance | null,
    port: number,
    expectedState: InstanceLifecycleExpectedState,
): boolean {
    return instance !== null && instance.port === port && instance.status === expectedState;
}

export class InstanceLifecycleController {
    private readonly fetchInstance: InstanceLifecycleFetch;
    private readonly clock: InstanceLifecycleClock;
    private readonly scheduler: InstanceLifecycleScheduler;
    private readonly deadlineMs: number;
    private readonly maxAttempts: number;
    private readonly pollDelayMs: number;
    private readonly onPhase?: InstanceLifecycleControllerOptions['onPhase'];
    private readonly onSnapshot?: InstanceLifecycleControllerOptions['onSnapshot'];
    private readonly shouldRetryError: (error: unknown) => boolean;
    private readonly listeners = new Set<() => void>();
    private generation = 0;
    private active: ActiveOperation | null = null;
    private currentSnapshot: InstanceLifecycleSnapshot = IDLE_SNAPSHOT;
    private disposed = false;

    constructor(options: InstanceLifecycleControllerOptions) {
        this.fetchInstance = options.fetchInstance;
        this.clock = options.clock ?? browserClock;
        this.scheduler = options.scheduler ?? browserScheduler;
        this.deadlineMs = options.deadlineMs ?? INSTANCE_LIFECYCLE_DEADLINE_MS;
        this.maxAttempts = options.maxAttempts ?? INSTANCE_LIFECYCLE_MAX_ATTEMPTS;
        this.pollDelayMs = options.pollDelayMs ?? INSTANCE_LIFECYCLE_POLL_DELAY_MS;
        this.onPhase = options.onPhase;
        this.onSnapshot = options.onSnapshot;
        this.shouldRetryError = options.shouldRetryError ?? (() => true);
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): InstanceLifecycleSnapshot => this.currentSnapshot;

    start(options: StartInstanceLifecycleOptions): Promise<InstanceLifecycleSnapshot> {
        if (this.disposed) throw new Error('InstanceLifecycleController is disposed');
        this.cancelActive(true);

        const startedAt = this.clock.now();
        const operation: ActiveOperation = {
            generation: ++this.generation,
            port: options.port,
            expectedState: options.expectedState,
            startedAt,
            deadlineAt: startedAt + this.deadlineMs,
            abortController: new AbortController(),
            wakePending: false,
            interruptDelay: null,
        };
        this.active = operation;
        this.commit(operation, {
            phase: 'polling',
            attempts: 0,
            instance: null,
            lastError: null,
        });
        return this.run(operation);
    }

    wake(): void {
        const operation = this.active;
        if (!operation || operation.abortController.signal.aborted || operation.wakePending) return;
        operation.wakePending = true;
        operation.interruptDelay?.();
    }

    abort(): void {
        this.cancelActive(true);
    }

    dispose(): void {
        if (this.disposed) return;
        this.cancelActive(true);
        this.disposed = true;
        this.listeners.clear();
    }

    private async run(operation: ActiveOperation): Promise<InstanceLifecycleSnapshot> {
        while (this.isCurrent(operation)) {
            if (this.clock.now() >= operation.deadlineAt
                || this.currentSnapshot.attempts >= this.maxAttempts) {
                return this.finish(operation, 'timed-out');
            }

            const attempts = this.currentSnapshot.attempts + 1;
            this.commit(operation, { phase: 'polling', attempts });
            const outcome = await this.fetchAttempt(operation);
            if (!this.isCurrent(operation)) return this.abortedSnapshot(operation);

            if (outcome.kind === 'aborted') return this.finish(operation, 'aborted');
            if (outcome.kind === 'deadline') return this.finish(operation, 'timed-out');
            if (outcome.kind === 'result') {
                if (this.clock.now() >= operation.deadlineAt) {
                    return this.finish(operation, 'timed-out', outcome.instance);
                }
                this.commit(operation, {
                    phase: 'polling',
                    instance: outcome.instance,
                    lastError: null,
                });
                if (hasConverged(outcome.instance, operation.port, operation.expectedState)) {
                    return this.finish(operation, operation.expectedState, outcome.instance);
                }
            } else {
                if (!this.shouldRetryError(outcome.error)) {
                    return this.finish(operation, 'error', null, errorMessage(outcome.error));
                }
                this.commit(operation, {
                    phase: 'polling',
                    instance: null,
                    lastError: errorMessage(outcome.error),
                });
            }

            if (this.currentSnapshot.attempts >= this.maxAttempts) {
                return this.finish(operation, 'timed-out');
            }
            if (operation.wakePending) {
                operation.wakePending = false;
                continue;
            }

            const delayOutcome = await this.waitForNextAttempt(operation);
            if (!this.isCurrent(operation)) return this.abortedSnapshot(operation);
            if (delayOutcome === 'aborted') return this.finish(operation, 'aborted');
            if (delayOutcome === 'deadline') return this.finish(operation, 'timed-out');
            operation.wakePending = false;
        }
        return this.abortedSnapshot(operation);
    }

    private fetchAttempt(operation: ActiveOperation): Promise<FetchOutcome> {
        const remainingMs = operation.deadlineAt - this.clock.now();
        if (remainingMs <= 0) return Promise.resolve({ kind: 'deadline' });

        return new Promise(resolve => {
            let settled = false;
            const signal = operation.abortController.signal;
            const finish = (outcome: FetchOutcome): void => {
                if (settled) return;
                settled = true;
                this.scheduler.clearTimeout(deadlineTimer);
                signal.removeEventListener('abort', onAbort);
                resolve(outcome);
            };
            const onAbort = (): void => finish({ kind: 'aborted' });
            const deadlineTimer = this.scheduler.setTimeout(() => {
                finish({ kind: 'deadline' });
                operation.abortController.abort();
            }, remainingMs);
            signal.addEventListener('abort', onAbort, { once: true });
            void this.fetchInstance(operation.port, { signal }).then(
                instance => finish({ kind: 'result', instance }),
                error => finish(signal.aborted ? { kind: 'aborted' } : { kind: 'error', error }),
            );
        });
    }

    private waitForNextAttempt(operation: ActiveOperation): Promise<'elapsed' | 'wake' | 'deadline' | 'aborted'> {
        const remainingMs = operation.deadlineAt - this.clock.now();
        if (remainingMs <= 0) return Promise.resolve('deadline');
        const delayMs = Math.min(this.pollDelayMs, remainingMs);

        return new Promise(resolve => {
            let settled = false;
            const signal = operation.abortController.signal;
            const finish = (outcome: 'elapsed' | 'wake' | 'deadline' | 'aborted'): void => {
                if (settled) return;
                settled = true;
                this.scheduler.clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                operation.interruptDelay = null;
                resolve(outcome);
            };
            const onAbort = (): void => finish('aborted');
            const timer = this.scheduler.setTimeout(() => {
                finish(delayMs === remainingMs ? 'deadline' : 'elapsed');
            }, delayMs);
            operation.interruptDelay = () => finish('wake');
            signal.addEventListener('abort', onAbort, { once: true });
            if (operation.wakePending) operation.interruptDelay();
        });
    }

    private cancelActive(emit: boolean): void {
        const operation = this.active;
        if (!operation) return;
        this.active = null;
        operation.interruptDelay?.();
        operation.abortController.abort();
        if (emit) this.publish(this.abortedSnapshot(operation));
    }

    private isCurrent(operation: ActiveOperation): boolean {
        return this.active === operation
            && this.generation === operation.generation;
    }

    private commit(
        operation: ActiveOperation,
        patch: Partial<Pick<InstanceLifecycleSnapshot, 'phase' | 'attempts' | 'instance' | 'lastError'>>,
    ): void {
        if (!this.isCurrent(operation)) return;
        this.publish({
            ...this.currentSnapshot,
            generation: operation.generation,
            port: operation.port,
            expectedState: operation.expectedState,
            startedAt: operation.startedAt,
            deadlineAt: operation.deadlineAt,
            ...patch,
        });
    }

    private finish(
        operation: ActiveOperation,
        phase: Exclude<InstanceLifecyclePhase, 'idle' | 'polling'>,
        instance = this.currentSnapshot.instance,
        lastError = this.currentSnapshot.lastError,
    ): InstanceLifecycleSnapshot {
        if (!this.isCurrent(operation)) return this.abortedSnapshot(operation);
        this.active = null;
        if (phase === 'timed-out') operation.abortController.abort();
        const snapshot = { ...this.currentSnapshot, phase, instance, lastError };
        this.publish(snapshot);
        return snapshot;
    }

    private abortedSnapshot(operation: ActiveOperation): InstanceLifecycleSnapshot {
        return {
            generation: operation.generation,
            phase: 'aborted',
            port: operation.port,
            expectedState: operation.expectedState,
            attempts: this.currentSnapshot.generation === operation.generation
                ? this.currentSnapshot.attempts
                : 0,
            startedAt: operation.startedAt,
            deadlineAt: operation.deadlineAt,
            instance: null,
            lastError: null,
        };
    }

    private publish(snapshot: InstanceLifecycleSnapshot): void {
        const previousPhase = this.currentSnapshot.phase;
        this.currentSnapshot = Object.freeze(snapshot);
        this.onSnapshot?.(this.currentSnapshot);
        if (previousPhase !== snapshot.phase) this.onPhase?.(snapshot.phase, this.currentSnapshot);
        for (const listener of this.listeners) listener();
    }
}

export function createInstanceLifecycleController(
    options: InstanceLifecycleControllerOptions,
): InstanceLifecycleController {
    return new InstanceLifecycleController(options);
}
