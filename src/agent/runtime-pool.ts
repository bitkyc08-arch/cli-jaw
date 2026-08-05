import { CodexAppClient, isRecoverableResumeError } from './codex-app-client.js';
import {
    normalizePiSettings,
    spawnPersistentPiRpc,
    type PiApiKind,
    type PiRpcSession,
} from './pi-runtime.js';

const DEFAULT_POOL_WAIT_MS = 60_000;
const DEFAULT_POOL_IDLE_MS = 15 * 60_000;
const POOL_SWEEP_MS = 60_000;
const INTERRUPT_LATCH_MS = 10_000;

export interface CodexAppPoolKey {
    scopeKey: string;
    cwd: string;
    model: string;
    effort: string;
    fastMode: boolean;
}

export interface ManagedRuntime {
    readonly alive: boolean;
    readonly supportsInterrupt: boolean;
    close(): Promise<void> | void;
    interrupt(): Promise<void>;
    kill(): void;
    onExit(cb: (code: number | null) => void): () => void;
}

type AcquireWaiter = {
    id: number;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
};

type PoolEntry<R extends ManagedRuntime, S> =
    | { state: 'creating'; scopeKey: string; waiters: AcquireWaiter[]; lastUsedAt: number }
    | { state: 'ready'; scopeKey: string; runtime: R; sessionId: S | null;
        busy: boolean; dead: boolean; waiters: AcquireWaiter[]; lastUsedAt: number;
        disposeExit: () => void };

type ReadyEntry<R extends ManagedRuntime, S> = Extract<PoolEntry<R, S>, { state: 'ready' }>;

export interface AcquireOptions {
    binary: string;
    env: NodeJS.ProcessEnv;
    route: 'legacy' | 'multiplex';
    key: CodexAppPoolKey;
    storedThreadId?: string | null;
    instructions?: string;
    forceNew?: boolean;
    waitMs?: number;
}

export interface RuntimeLease<R extends ManagedRuntime, S> {
    runtime: R;
    sessionId: S;
    reused: boolean;
    release(): void;
    cancel(): Promise<void>;
}

export interface CodexAppLease extends RuntimeLease<ManagedRuntime, string> {
    client: CodexAppClient;
    threadId: string;
    resumedThread: boolean;
}

export interface PiLease extends RuntimeLease<ManagedRuntime, string | null> {
    session: PiRpcSession;
}

export interface PiAcquireOptions {
    key: {
        scopeKey: string;
        cwd: string;
        profileId: string;
        fullEndpoint: string;
        apiKind: PiApiKind;
        model: string;
        effort: string;
        profileFp: string;
    };
    piSettings: unknown;
    storedSessionId?: string | null;
    instructions?: string;
    forceNew?: boolean;
    waitMs?: number;
}

type Engine = 'codex-app' | 'pi';
type AnyEntry = PoolEntry<ManagedRuntime, unknown>;
type EngineStore = {
    entries: Map<string, AnyEntry>;
    scopeIndex: Map<string, Set<string>>;
};

const stores = new Map<Engine, EngineStore>();
let nextWaiterId = 1;
let reaper: NodeJS.Timeout | null = null;

function storeFor(engine: Engine): EngineStore {
    let store = stores.get(engine);
    if (!store) {
        store = { entries: new Map(), scopeIndex: new Map() };
        stores.set(engine, store);
    }
    return store;
}

function fullKey(key: CodexAppPoolKey): string {
    return JSON.stringify([key.scopeKey, key.cwd, key.model, key.effort, key.fastMode]);
}

function fullPiKey(key: PiAcquireOptions['key']): string {
    return JSON.stringify([
        'pi', key.scopeKey, key.cwd, key.profileId, key.fullEndpoint.replace(/\/+$/, ''),
        key.apiKind, key.model, key.effort, key.profileFp,
    ]);
}

function configuredMs(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function drainWaiters(entry: { waiters: AcquireWaiter[] }, outcome: 'wake' | Error): void {
    const pending = entry.waiters.splice(0);
    for (const waiter of pending) {
        clearTimeout(waiter.timer);
        if (outcome instanceof Error) waiter.reject(outcome);
        else waiter.resolve();
    }
}

function removeWaiter(entry: { waiters: AcquireWaiter[] }, id: number): void {
    const index = entry.waiters.findIndex((waiter) => waiter.id === id);
    if (index >= 0) entry.waiters.splice(index, 1);
}

function waitForEntry(entry: { waiters: AcquireWaiter[] }, waitMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const id = nextWaiterId++;
        const timer = setTimeout(() => {
            removeWaiter(entry, id);
            reject(new Error(`runtime pool acquire timed out after ${waitMs}ms`));
        }, waitMs);
        entry.waiters.push({ id, resolve, reject, timer });
    });
}

function unindex(store: EngineStore, scopeKey: string, key: string): void {
    const keys = store.scopeIndex.get(scopeKey);
    keys?.delete(key);
    if (keys?.size === 0) store.scopeIndex.delete(scopeKey);
}

function removeEntry(store: EngineStore, key: string, entry: AnyEntry, reason: Error): void {
    if (store.entries.get(key) !== entry) return;
    store.entries.delete(key);
    unindex(store, entry.scopeKey, key);
    drainWaiters(entry, reason);
    if (entry.state === 'ready') entry.disposeExit();
}

function closeEntry(store: EngineStore, key: string, entry: AnyEntry, reason: Error): void {
    removeEntry(store, key, entry, reason);
    if (entry.state === 'ready') {
        void Promise.resolve(entry.runtime.close()).catch((err: unknown) => {
            console.warn('[runtime-pool] close failed:', (err as Error).message);
        });
    }
}

function replaceScopeEntries(store: EngineStore, scopeKey: string, keepKey: string | null): void {
    for (const key of [...(store.scopeIndex.get(scopeKey) ?? [])]) {
        if (key === keepKey) continue;
        const entry = store.entries.get(key);
        if (entry) closeEntry(store, key, entry, new Error('runtime pool entry replaced'));
    }
}

type CodexManagedRuntime = ManagedRuntime & { readonly client: CodexAppClient };

export function resolveCodexAppProductionLaneScope(_options: {
    multiplexEnabled: boolean;
    employee: boolean;
}): null {
    return null;
}

export async function interruptCodexRuntime(
    client: CodexAppClient,
    laneScope: string | null,
): Promise<void> {
    if (laneScope === null) {
        if (client.activeTurnId) {
            await client.interruptTurn();
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                client.off('interrupt-failed', onFailed);
                client.off('turn/completed', onCompleted);
                clearTimeout(timer);
            };
            const onFailed = (err: Error) => { cleanup(); reject(err); };
            const onCompleted = () => { cleanup(); resolve(); };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('interrupt latch timeout'));
            }, INTERRUPT_LATCH_MS);
            client.once('interrupt-failed', onFailed);
            client.once('turn/completed', onCompleted);
            void client.interruptTurn();
        });
        return;
    }

    if (client.getActiveTurnId(laneScope)) {
        await client.interruptTurn(laneScope);
        return;
    }
    const expectedThreadId = client.getThreadId(laneScope);
    await new Promise<void>((resolve, reject) => {
        let disposed = false;
        let timer: NodeJS.Timeout;
        let listener: { dispose(): void } | null = null;
        const cleanup = () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            listener?.dispose();
        };
        const onFailed = (err: Error) => { cleanup(); reject(err); };
        listener = client.listenTurn(laneScope, {
            role: 'lifecycle',
            onNotification: (method, _params, owner) => {
                const expectedTurnId = client.getActiveTurnId(laneScope);
                if (
                    method !== 'turn/completed'
                    || !expectedThreadId
                    || !expectedTurnId
                    || !owner
                    || owner.threadId !== expectedThreadId
                    || owner.turnId !== expectedTurnId
                ) return;
                cleanup();
                resolve();
            },
            onStderr: () => {},
            onExit: (code, signal) => {
                onFailed(new Error(`Codex AppServer exited (code=${code}, signal=${signal})`));
            },
            onError: onFailed,
            onInterruptFailed: onFailed,
        });
        timer = setTimeout(() => {
            onFailed(new Error('interrupt latch timeout'));
        }, INTERRUPT_LATCH_MS);
        void client.interruptTurn(laneScope).catch(onFailed);
    });
}

function codexRuntime(client: CodexAppClient, laneScope: string | null): CodexManagedRuntime {
    return {
        client,
        get alive() { return client.alive; },
        supportsInterrupt: true,
        close: () => client.closeGracefully(),
        interrupt: () => interruptCodexRuntime(client, laneScope),
        kill: () => client.kill(),
        onExit: (cb) => {
            const listener = (code: number | null) => { cb(code); };
            const errorListener = () => { cb(null); };
            client.on('exit', listener);
            client.on('error', errorListener);
            return () => {
                client.off('exit', listener);
                client.off('error', errorListener);
            };
        },
    };
}

type PiManagedRuntime = ManagedRuntime & { readonly session: PiRpcSession };

function piRuntime(session: PiRpcSession): PiManagedRuntime {
    return {
        session,
        get alive() { return session.alive; },
        supportsInterrupt: session.abortEffective,
        close: () => session.close(),
        interrupt: () => session.abort(),
        kill: () => session.kill(),
        onExit: (cb) => {
            const listener = (code: number | null) => { cb(code); };
            session.child.on('exit', listener);
            return () => { session.child.off('exit', listener); };
        },
    };
}

async function cancelLease<R extends ManagedRuntime, S>(entry: ReadyEntry<R, S>): Promise<void> {
    if (entry.runtime.supportsInterrupt) {
        try {
            await entry.runtime.interrupt();
            return;
        } catch {
            // Fall through: cancellation must not be lost when interrupt fails.
        }
    }
    entry.runtime.kill();
    entry.dead = true;
    drainWaiters(entry, new Error('runtime cancelled and discarded'));
}

function makeCodexLease(
    store: EngineStore,
    key: string,
    entry: ReadyEntry<ManagedRuntime, unknown>,
    client: CodexAppClient,
    threadId: string,
    reused: boolean,
    resumedThread: boolean,
): CodexAppLease {
    let released = false;
    return {
        runtime: entry.runtime,
        sessionId: threadId,
        client,
        threadId,
        reused,
        resumedThread,
        release: () => {
            if (released) return;
            released = true;
            entry.lastUsedAt = Date.now();
            entry.busy = false;
            if (entry.dead || !entry.runtime.alive) {
                removeEntry(store, key, entry, new Error('runtime exited'));
                return;
            }
            drainWaiters(entry, 'wake');
        },
        cancel: () => cancelLease(entry),
    };
}

function piSessionForLease(session: PiRpcSession, instructions?: string): PiRpcSession {
    if (!instructions) return session;
    return {
        child: session.child,
        get alive() { return session.alive; },
        abortEffective: session.abortEffective,
        get sessionId() { return session.sessionId; },
        set sessionId(value) { session.sessionId = value; },
        sendPrompt: (message, opts) => session.sendPrompt(`${instructions}\n\n${message}`, opts),
        abort: () => session.abort(),
        close: () => session.close(),
        kill: () => session.kill(),
    };
}

function makePiLease(
    store: EngineStore,
    key: string,
    entry: ReadyEntry<ManagedRuntime, unknown>,
    session: PiRpcSession,
    reused: boolean,
    instructions?: string,
): PiLease {
    let released = false;
    return {
        runtime: entry.runtime,
        sessionId: session.sessionId,
        session: piSessionForLease(session, instructions),
        reused,
        release: () => {
            if (released) return;
            released = true;
            entry.sessionId = session.sessionId;
            entry.lastUsedAt = Date.now();
            entry.busy = false;
            if (entry.dead || !entry.runtime.alive) {
                removeEntry(store, key, entry, new Error('runtime exited'));
                return;
            }
            drainWaiters(entry, 'wake');
        },
        cancel: () => cancelLease(entry),
    };
}

async function createCodexEntry(
    store: EngineStore,
    key: string,
    creating: Extract<AnyEntry, { state: 'creating' }>,
    opts: AcquireOptions,
): Promise<CodexAppLease> {
    const client = new CodexAppClient({
        binary: opts.binary,
        workDir: opts.key.cwd,
        env: opts.env,
        model: opts.key.model,
        effort: opts.key.effort,
        fastMode: opts.key.fastMode,
    });
    client.spawn();
    try {
        await client.initialize();
        let resumedThread = false;
        let threadId: string;
        const storedThreadId = opts.forceNew ? null : opts.storedThreadId;
        if (storedThreadId) {
            try {
                threadId = await client.resumeThread(storedThreadId,
                    opts.instructions ? { instructions: opts.instructions } : {});
                resumedThread = true;
            } catch (err: unknown) {
                if (!isRecoverableResumeError((err as Error).message)) throw err;
                threadId = await client.startThread({
                    ...(opts.instructions ? { instructions: opts.instructions } : {}),
                    cwd: opts.key.cwd,
                });
            }
        } else {
            threadId = await client.startThread({
                ...(opts.instructions ? { instructions: opts.instructions } : {}),
                cwd: opts.key.cwd,
            });
        }
        if (store.entries.get(key) !== creating) {
            await client.closeGracefully();
            throw new Error('runtime pool creation superseded');
        }
        const runtime = codexRuntime(client, null);
        let ready!: ReadyEntry<ManagedRuntime, unknown>;
        const disposeExit = runtime.onExit(() => {
            if (store.entries.get(key) !== ready) return;
            ready.dead = true;
            drainWaiters(ready, new Error('runtime exited'));
            if (!ready.busy) removeEntry(store, key, ready, new Error('runtime exited'));
        });
        ready = {
            state: 'ready', scopeKey: opts.key.scopeKey, runtime, sessionId: threadId,
            busy: true, dead: false, waiters: [], lastUsedAt: Date.now(), disposeExit,
        };
        store.entries.set(key, ready);
        drainWaiters(creating, 'wake');
        return makeCodexLease(store, key, ready, client, threadId, false, resumedThread);
    } catch (err: unknown) {
        client.kill();
        removeEntry(store, key, creating, err as Error);
        throw err;
    }
}

export async function acquireCodexAppRuntime(opts: AcquireOptions): Promise<CodexAppLease> {
    if (opts.route === 'multiplex') {
        throw new Error('multiplex route reached generic Codex App runtime pool');
    }
    startPoolReaper();
    const store = storeFor('codex-app');
    const key = fullKey(opts.key);
    const waitMs = opts.waitMs ?? configuredMs(process.env["CODEX_APP_POOL_WAIT_MS"], DEFAULT_POOL_WAIT_MS);
    replaceScopeEntries(store, opts.key.scopeKey, opts.forceNew ? null : key);
    let forceNewApplied = !opts.forceNew;

    for (;;) {
        let entry = store.entries.get(key);
        if (!forceNewApplied) {
            forceNewApplied = true;
            if (entry) closeEntry(store, key, entry, new Error('runtime pool forceNew replacement'));
            entry = undefined;
        }
        if (!entry) {
            const creating: Extract<AnyEntry, { state: 'creating' }> = {
                state: 'creating', scopeKey: opts.key.scopeKey, waiters: [], lastUsedAt: Date.now(),
            };
            store.entries.set(key, creating);
            let keys = store.scopeIndex.get(opts.key.scopeKey);
            if (!keys) {
                keys = new Set();
                store.scopeIndex.set(opts.key.scopeKey, keys);
            }
            keys.add(key);
            return createCodexEntry(store, key, creating, opts);
        }
        if (entry.state === 'creating') {
            await waitForEntry(entry, waitMs);
            continue;
        }
        if (entry.dead || !entry.runtime.alive || (opts.storedThreadId && entry.sessionId !== opts.storedThreadId)) {
            closeEntry(store, key, entry, new Error('runtime pool entry stale'));
            continue;
        }
        if (!entry.busy) {
            entry.busy = true;
            entry.lastUsedAt = Date.now();
            const client = (entry.runtime as CodexManagedRuntime).client;
            return makeCodexLease(store, key, entry, client, entry.sessionId as string, true, true);
        }
        await waitForEntry(entry, waitMs);
    }
}

async function createPiEntry(
    store: EngineStore,
    key: string,
    creating: Extract<AnyEntry, { state: 'creating' }>,
    opts: PiAcquireOptions,
): Promise<PiLease> {
    const pi = normalizePiSettings(opts.piSettings);
    const profile = pi.profiles.find((entry) => entry.id === opts.key.profileId);
    if (!profile) {
        const error = new Error(`Pi profile not found: ${opts.key.profileId}`);
        removeEntry(store, key, creating, error);
        throw error;
    }
    let session: PiRpcSession | null = null;
    try {
        session = spawnPersistentPiRpc(profile, pi, {
            model: opts.key.model,
            effort: opts.key.effort,
            cwd: opts.key.cwd,
            ...(opts.forceNew || !opts.storedSessionId ? {} : { sessionId: opts.storedSessionId }),
        });
        if (store.entries.get(key) !== creating) {
            session.close();
            throw new Error('runtime pool creation superseded');
        }
        const runtime = piRuntime(session);
        let ready!: ReadyEntry<ManagedRuntime, unknown>;
        const disposeExit = runtime.onExit(() => {
            if (store.entries.get(key) !== ready) return;
            ready.dead = true;
            drainWaiters(ready, new Error('runtime exited'));
            if (!ready.busy) removeEntry(store, key, ready, new Error('runtime exited'));
        });
        ready = {
            state: 'ready', scopeKey: opts.key.scopeKey, runtime, sessionId: session.sessionId,
            busy: true, dead: false, waiters: [], lastUsedAt: Date.now(), disposeExit,
        };
        store.entries.set(key, ready);
        drainWaiters(creating, 'wake');
        return makePiLease(store, key, ready, session, false, opts.instructions);
    } catch (err: unknown) {
        session?.kill();
        removeEntry(store, key, creating, err as Error);
        throw err;
    }
}

export async function acquirePiRuntime(opts: PiAcquireOptions): Promise<PiLease> {
    startPoolReaper();
    const store = storeFor('pi');
    const key = fullPiKey(opts.key);
    const waitMs = opts.waitMs ?? configuredMs(process.env["PI_POOL_WAIT_MS"], DEFAULT_POOL_WAIT_MS);
    replaceScopeEntries(store, opts.key.scopeKey, opts.forceNew ? null : key);
    let forceNewApplied = !opts.forceNew;

    for (;;) {
        let entry = store.entries.get(key);
        if (!forceNewApplied) {
            forceNewApplied = true;
            if (entry) closeEntry(store, key, entry, new Error('runtime pool forceNew replacement'));
            entry = undefined;
        }
        if (!entry) {
            const creating: Extract<AnyEntry, { state: 'creating' }> = {
                state: 'creating', scopeKey: opts.key.scopeKey, waiters: [], lastUsedAt: Date.now(),
            };
            store.entries.set(key, creating);
            let keys = store.scopeIndex.get(opts.key.scopeKey);
            if (!keys) {
                keys = new Set();
                store.scopeIndex.set(opts.key.scopeKey, keys);
            }
            keys.add(key);
            return createPiEntry(store, key, creating, opts);
        }
        if (entry.state === 'creating') {
            await waitForEntry(entry, waitMs);
            continue;
        }
        const session = (entry.runtime as PiManagedRuntime).session;
        if (entry.dead || !entry.runtime.alive
            || (opts.storedSessionId && entry.sessionId !== opts.storedSessionId)) {
            closeEntry(store, key, entry, new Error('runtime pool entry stale'));
            continue;
        }
        if (!entry.busy) {
            entry.busy = true;
            entry.lastUsedAt = Date.now();
            return makePiLease(store, key, entry, session, true, opts.instructions);
        }
        await waitForEntry(entry, waitMs);
    }
}

export function startPoolReaper(idleMs = DEFAULT_POOL_IDLE_MS): void {
    if (reaper) return;
    reaper = setInterval(() => {
        const now = Date.now();
        for (const store of stores.values()) {
            for (const [key, entry] of store.entries) {
                if (entry.state === 'ready' && !entry.busy && now - entry.lastUsedAt >= idleMs) {
                    closeEntry(store, key, entry, new Error('runtime pool idle timeout'));
                }
            }
        }
    }, POOL_SWEEP_MS);
    reaper.unref();
}

export function poolStats(): { size: number; busy: number } {
    let size = 0;
    let busy = 0;
    for (const store of stores.values()) {
        size += store.entries.size;
        for (const entry of store.entries.values()) {
            if (entry.state === 'ready' && entry.busy) busy += 1;
        }
    }
    return { size, busy };
}
