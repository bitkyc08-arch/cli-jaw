import type { SessionOwnerToken } from './session-persistence.js';

/** Provider adapters share the existing pool owner through this type-only port. */
export interface ManagedRuntime {
    readonly alive: boolean;
    readonly supportsInterrupt: boolean;
    close(): Promise<void> | void;
    interrupt(): Promise<void>;
    kill(): void;
    onExit(cb: (code: number | null) => void): () => void;
}

export type AcquireWaiter = {
    id: number;
    resolve(): void;
    reject(err: Error): void;
    timer: NodeJS.Timeout;
    cleanup?: () => void;
};

export type PoolEntry<R extends ManagedRuntime, S> =
    | { state: 'creating'; scopeKey: string; waiters: AcquireWaiter[]; lastUsedAt: number;
        abortCreate?: () => void; nativeOwner?: SessionOwnerToken }
    | { state: 'ready'; scopeKey: string; runtime: R; sessionId: S | null;
        busy: boolean; dead: boolean; waiters: AcquireWaiter[]; lastUsedAt: number;
        disposeExit(): void; nativeOwner?: SessionOwnerToken; leaseOwner?: symbol;
        cursorRetirement?: Promise<void> };

export interface RuntimeLease<R extends ManagedRuntime, S> {
    runtime: R;
    sessionId: S;
    reused: boolean;
    release(): void;
    cancel(): Promise<void>;
}

export type RuntimePoolEntry = PoolEntry<ManagedRuntime, unknown>;
export type RuntimePoolStore = {
    entries: Map<string, RuntimePoolEntry>;
    scopeIndex: Map<string, Set<string>>;
};

export interface RuntimePoolAccess {
    store: RuntimePoolStore;
    wait(entry: { waiters: AcquireWaiter[] }, waitMs: number, signal?: AbortSignal): Promise<void>;
    remove(store: RuntimePoolStore, key: string, entry: RuntimePoolEntry, reason: Error): void;
    wake(entry: RuntimePoolEntry): void;
}
