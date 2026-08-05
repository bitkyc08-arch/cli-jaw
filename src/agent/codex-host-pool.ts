import { createHmac, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';
import { resolveCodexAppLaneKey, resolveScopedSessionBucket, type CodexAppLaneMode } from './args.js';
import { CodexAppClient, isRecoverableResumeError, type CodexThreadOptions } from './codex-app-client.js';
const DEFAULT_WAIT_MS = 60_000, LANE_IDLE_MS = 15 * 60_000, HOST_IDLE_MS = 15 * 60_000, SWEEP_MS = 60_000;
const ENV_HMAC_KEY = randomBytes(32);
export interface CodexHostPrepareOptions {
    binary: string; cwd: string; fastMode: boolean; env: NodeJS.ProcessEnv;
    model: string; effort: string;
}
export interface PreparedCodexAppHost { readonly laneMode: CodexAppLaneMode }
export interface CodexLaneAcquireOptions {
    scopeKey: string; bucketKey: string; instructions?: string;
    storedThreadId?: string | null; forceNew?: boolean; waitMs?: number;
}
export class CodexHostGenerationStaleError extends Error {
    readonly code = 'CODEX_HOST_GENERATION_STALE';
    constructor(message = 'Prepared Codex App host generation is stale') {
        super(message); this.name = 'CodexHostGenerationStaleError'; }
}
export class CodexHostPoolClosingError extends Error {
    readonly code = 'CODEX_HOST_POOL_CLOSING';
    constructor(message = 'Codex App host pool is closing') {
        super(message); this.name = 'CodexHostPoolClosingError'; }
}
export interface CodexAppLaneLease {
    readonly client: CodexAppClient; readonly scopeKey: string; readonly laneScope: string;
    readonly bucketKey: string; readonly threadId: string; readonly laneMode: CodexAppLaneMode;
    readonly reused: boolean; readonly resumedThread: boolean; release(): void; cancel(): Promise<void>;
}
export interface CodexHostPoolShutdownOptions {
    reason?: string; deadlineAt: number; reserveMs?: number;
}
type HostState = 'creating' | 'ready' | 'closing' | 'dead';
type LaneState = 'idle' | 'busy' | 'poisoned' | 'closing';
type Waiter = {
    resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout | null;
    lane: Lane; settled: boolean;
};
type Lane = {
    laneScope: string; scopeKey: string; state: LaneState; threadId: string | null;
    model: string; effort: string; cwd: string; fastMode: boolean; waiters: Waiter[];
    lastUsedAt: number; initializedGeneration: number; handoff: boolean;
    maintenanceQueued: boolean; listener: { dispose(): void } | null; bindingEpoch: number;
    // Set when a reset lands while this lane is running. The binding is dropped on
    // whichever path returns the lane to idle rather than immediately, because the turn
    // in flight is still using it.
    bindingRevoked: boolean;
};
type Host = {
    key: string; state: HostState; generation: number; client: CodexAppClient | null;
    laneMode: 'fallback'; lanes: Map<string, Lane>; lastUsedAt: number;
    maintenance: Promise<void> | null; creation: Promise<void> | null;
    disposeDeath: (() => void) | null; binary: string; cwd: string; fastMode: boolean;
    model: string; effort: string; envSnapshot: NodeJS.ProcessEnv; envIdentity: string;
    failure: Promise<never>; rejectFailure(error: Error): void;
};
type TokenMeta = {
    host: Host; hostKey: string; generation: number; client: CodexAppClient;
    model: string; effort: string; cwd: string; fastMode: boolean;
    envSnapshot: NodeJS.ProcessEnv; envIdentity: string; laneMode: 'fallback'; consumed: boolean;
};
const hosts = new Map<string, Host>(); const closingHosts = new Set<Host>();
let tokenMetadata = new WeakMap<PreparedCodexAppHost, TokenMeta>();
let nextGeneration = 1, nextBindingEpoch = 1, reaper: NodeJS.Timeout | null = null, closing = false;
let shutdownPromise: Promise<void> | null = null;
function snapshotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const snapshot: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(env).sort()) {
        const value = env[key];
        if (value !== undefined) snapshot[process.platform === 'win32' ? key.toLowerCase() : key] = value;
    }
    return Object.freeze(snapshot);
}
function envFingerprint(env: NodeJS.ProcessEnv): string {
    const hmac = createHmac('sha256', ENV_HMAC_KEY);
    for (const key of Object.keys(env).sort()) hmac.update(key).update('\0').update(env[key]!).update('\0');
    return hmac.digest('hex');
}
function canonicalCwd(cwd: string): string {
    const absolute = resolve(cwd);
    try { return realpathSync.native(absolute); } catch { return absolute; }
}
function resolvedBinary(binary: string, cwd: string, env: NodeJS.ProcessEnv): string {
    const explicit = isAbsolute(binary) || binary.includes('/') || binary.includes('\\');
    const candidates = explicit
        ? [resolve(cwd, binary)]
        : (env['PATH'] ?? env['path'] ?? '').split(delimiter).filter(Boolean).map((dir) => resolve(dir, binary));
    for (const candidate of candidates) {
        try { return realpathSync.native(candidate); } catch { /* keep looking */ }
    }
    return explicit ? resolve(cwd, binary) : binary.split(sep).join('/');
}
function stale(message?: string): CodexHostGenerationStaleError { return new CodexHostGenerationStaleError(message); }
function hostFailure(): { promise: Promise<never>; reject(error: Error): void } {
    let reject!: (error: Error) => void;
    const promise = new Promise<never>((_resolve, fail) => { reject = fail; }); void promise.catch(() => {});
    return { promise, reject }; }
function settleWaiter(waiter: Waiter): boolean {
    if (waiter.settled) return false;
    waiter.settled = true;
    if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
    const queue = waiter.lane.waiters, index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    return true;
}
function rejectWaiters(lane: Lane, error: Error): void {
    lane.handoff = false;
    for (const waiter of [...lane.waiters]) if (settleWaiter(waiter)) waiter.reject(error);
    lane.waiters.length = 0;
}
function adoptWaiters(lane: Lane, waiters: Waiter[]): void {
    for (const waiter of waiters) waiter.lane = lane;
}
function wakeHead(lane: Lane): void {
    if (lane.handoff) return;
    for (;;) {
        const waiter = lane.waiters[0];
        if (!waiter) return;
        if (!settleWaiter(waiter)) { const index = lane.waiters.indexOf(waiter); if (index >= 0) lane.waiters.splice(index, 1); continue; }
        lane.handoff = true; waiter.resolve(); return;
    }
}
function removeLane(host: Host, lane: Lane, error?: Error): void {
    if (host.lanes.get(lane.laneScope) !== lane) return;
    if (error) rejectWaiters(lane, error);
    lane.listener?.dispose(); lane.listener = null;
    host.lanes.delete(lane.laneScope); host.lastUsedAt = Date.now();
}
function invalidateHost(host: Host, error: Error): void {
    if (host.state === 'dead') return;
    host.state = 'dead'; host.rejectFailure(error);
    if (hosts.get(host.key) === host) hosts.delete(host.key);
    closingHosts.delete(host);
    for (const lane of [...host.lanes.values()]) removeLane(host, lane, error);
    host.disposeDeath?.(); host.disposeDeath = null;
}
function attachDeathListener(host: Host, client: CodexAppClient): void {
    const onExit = (code: number | null, signal: string | null) => {
        invalidateHost(host, stale(`Codex App host exited (code=${code}, signal=${signal})`));
    };
    const onError = (error: Error) => { invalidateHost(host, stale(error.message)); };
    client.on('exit', onExit); client.on('error', onError);
    host.disposeDeath = () => { client.off('exit', onExit); client.off('error', onError); };
}
function enqueueMaintenance(host: Host, task: () => Promise<void>): void {
    const queued = (host.maintenance ?? Promise.resolve()).then(task, task);
    host.maintenance = queued;
    void queued.finally(() => { if (host.maintenance === queued) host.maintenance = null; }).catch(() => {});
}
function createLane(host: Host, meta: TokenMeta, scopeKey: string, waiters: Waiter[] = []): Lane {
    const laneScope = resolveCodexAppLaneKey(scopeKey, meta.model, meta.effort, meta.laneMode);
    const lane: Lane = {
        laneScope, scopeKey, state: 'idle', threadId: null, model: meta.model, effort: meta.effort,
        cwd: meta.cwd, fastMode: meta.fastMode, waiters, lastUsedAt: Date.now(),
        initializedGeneration: meta.generation, handoff: false, maintenanceQueued: false, listener: null,
        bindingEpoch: nextBindingEpoch++, bindingRevoked: false,
    };
    adoptWaiters(lane, waiters);
    const client = meta.client;
    lane.listener = client.listenTurn(laneScope, {
        role: 'lifecycle',
        onNotification: (method) => {
            if (method !== 'turn/completed' || (lane.state !== 'closing' && lane.state !== 'poisoned')) return;
            queueMicrotask(() => scheduleLaneClose(host, lane));
        },
        onStderr: () => {},
        onInterruptFailed: (error) => poisonLane(host, lane, error),
    });
    host.lanes.set(laneScope, lane);
    return lane;
}

// Apply a reset that landed while the lane was running. Called on EVERY path back to
// idle, not just lease release: a lane that returns to idle still holding a revoked
// thread would hand that conversation to the next turn.
function consumeRevokedBinding(lane: Lane): void {
    if (!lane.bindingRevoked) return;
    lane.bindingRevoked = false;
    lane.threadId = null;
    lane.bindingEpoch = nextBindingEpoch++;
}
function replaceClosedLane(host: Host, lane: Lane): void {
    const waiters = lane.waiters.splice(0);
    removeLane(host, lane);
    if (waiters.length === 0) return;
    if (host.state !== 'ready') {
        const error = stale('Codex App host is no longer ready');
        for (const waiter of waiters) if (settleWaiter(waiter)) waiter.reject(error);
        return;
    }
    const meta = tokenMetaFromHost(host);
    const replacement = createLane(host, meta, lane.scopeKey, waiters);
    wakeHead(replacement);
}
async function closeLane(host: Host, lane: Lane): Promise<void> {
    try {
        if (host.state !== 'ready' || host.lanes.get(lane.laneScope) !== lane) return;
        lane.state = 'closing';
        try { await host.client!.closeScope(lane.laneScope); }
        catch (error) {
            if (host.state !== 'ready' || host.lanes.get(lane.laneScope) !== lane) return;
            if (host.client!.getActiveTurnId(lane.laneScope)) return;
            consumeRevokedBinding(lane);
            lane.state = 'idle'; lane.lastUsedAt = Date.now(); wakeHead(lane); return;
        }
        if (host.state === 'ready' && host.lanes.get(lane.laneScope) === lane) replaceClosedLane(host, lane);
    } finally { lane.maintenanceQueued = false; }
}
function scheduleLaneClose(host: Host, lane: Lane): void {
    if (lane.maintenanceQueued || host.lanes.get(lane.laneScope) !== lane) return;
    lane.maintenanceQueued = true; enqueueMaintenance(host, () => closeLane(host, lane));
}
function poisonLane(host: Host, lane: Lane, error: Error): void {
    if (host.state !== 'ready' || host.lanes.get(lane.laneScope) !== lane) return;
    lane.state = 'poisoned'; rejectWaiters(lane, error);
    queueMicrotask(() => scheduleLaneClose(host, lane));
}
function tokenMetaFromHost(host: Host): TokenMeta {
    return {
        host, hostKey: host.key, generation: host.generation, client: host.client!, model: host.model,
        effort: host.effort, cwd: host.cwd, fastMode: host.fastMode, envSnapshot: host.envSnapshot,
        envIdentity: host.envIdentity, laneMode: host.laneMode, consumed: true,
    };
}
async function initializeHost(host: Host): Promise<void> {
    let client: CodexAppClient | null = null;
    try {
        client = new CodexAppClient({
            binary: host.binary, workDir: host.cwd, env: host.envSnapshot,
            unknownNotificationPolicy: 'diagnostic-only',
        });
        host.client = client; attachDeathListener(host, client); client.spawn();
        await client.initialize();
        if (closing) throw new CodexHostPoolClosingError();
        if (hosts.get(host.key) !== host || host.state !== 'creating') throw stale();
        host.state = 'ready'; host.lastUsedAt = Date.now();
    } catch (error) {
        invalidateHost(host, error as Error); client?.kill(); throw error;
    }
}
function startReaper(): void {
    if (reaper) return;
    reaper = setInterval(() => {
        const now = Date.now();
        for (const host of hosts.values()) {
            if (host.state !== 'ready') continue;
            for (const lane of host.lanes.values()) {
                if (lane.state === 'idle' && lane.waiters.length === 0 && now - lane.lastUsedAt >= LANE_IDLE_MS) {
                    scheduleLaneClose(host, lane);
                }
            }
            if (host.lanes.size === 0 && !host.maintenance && now - host.lastUsedAt >= HOST_IDLE_MS) {
                host.state = 'closing'; hosts.delete(host.key); closingHosts.add(host);
                enqueueMaintenance(host, async () => {
                    try { await host.client!.closeGracefully(); } catch { host.client!.kill(); }
                    invalidateHost(host, stale('Codex App host reaped'));
                });
            }
        }
    }, SWEEP_MS);
    reaper.unref();
}
export async function prepareCodexAppHost(options: CodexHostPrepareOptions): Promise<PreparedCodexAppHost> {
    if (closing) throw new CodexHostPoolClosingError();
    startReaper();
    const envSnapshot = snapshotEnv(options.env);
    const cwd = canonicalCwd(options.cwd);
    const binary = resolvedBinary(options.binary, cwd, envSnapshot);
    const envIdentity = envFingerprint(envSnapshot);
    const key = JSON.stringify([binary, cwd, options.fastMode, options.model, options.effort, envIdentity, 'fallback']);
    let host = hosts.get(key);
    if (!host) {
        const failure = hostFailure();
        host = {
            key, state: 'creating', generation: nextGeneration++, client: null, laneMode: 'fallback',
            lanes: new Map(), lastUsedAt: Date.now(), maintenance: null, creation: null,
            disposeDeath: null, binary, cwd, fastMode: options.fastMode, model: options.model,
            effort: options.effort, envSnapshot, envIdentity,
            failure: failure.promise, rejectFailure: failure.reject,
        };
        hosts.set(key, host); host.creation = initializeHost(host);
    }
    if (host.state === 'creating') await Promise.race([host.creation!, host.failure]);
    if (closing) throw new CodexHostPoolClosingError();
    if (hosts.get(key) !== host || host.state !== 'ready' || !host.client) throw stale();
    const prepared = Object.freeze({ laneMode: host.laneMode });
    tokenMetadata.set(prepared, { ...tokenMetaFromHost(host), consumed: false });
    return prepared;
}
function consumeToken(prepared: PreparedCodexAppHost, options: CodexLaneAcquireOptions): TokenMeta {
    const meta = tokenMetadata.get(prepared);
    if (!meta) { if (closing) throw new CodexHostPoolClosingError(); throw stale('Unknown prepared Codex App host token'); }
    if (meta.consumed) throw stale('Prepared Codex App host token was already consumed');
    meta.consumed = true;
    if (closing) throw new CodexHostPoolClosingError();
    const host = hosts.get(meta.hostKey);
    if (host !== meta.host || host.client !== meta.client || host.state !== 'ready'
        || host.generation !== meta.generation || host.envSnapshot !== meta.envSnapshot
        || host.model !== meta.model || host.effort !== meta.effort || host.cwd !== meta.cwd
        || host.fastMode !== meta.fastMode || host.envIdentity !== meta.envIdentity) throw stale();
    const bucket = resolveScopedSessionBucket(
        'codex-app', meta.model, null, options.scopeKey, meta.effort, meta.laneMode,
    );
    if (bucket !== options.bucketKey) throw stale(`Codex App bucket mismatch: expected ${bucket}`);
    return meta;
}
function assertCurrent(meta: TokenMeta): void {
    if (closing) throw new CodexHostPoolClosingError();
    const host = hosts.get(meta.hostKey);
    if (host !== meta.host || host.state !== 'ready' || host.client !== meta.client
        || host.generation !== meta.generation) throw stale();
}
function waitForLane(lane: Lane, waitMs: number): Promise<void> {
    if (waitMs <= 0) return Promise.reject(new Error('Codex App lane acquire timed out'));
    return new Promise((resolveWaiter, reject) => {
        const waiter: Waiter = {
            resolve: resolveWaiter, reject, lane, settled: false, timer: null,
        };
        waiter.timer = setTimeout(() => {
            if (!settleWaiter(waiter)) return;
            reject(new Error(`Codex App lane acquire timed out after ${waitMs}ms`));
        }, waitMs);
        lane.waiters.push(waiter);
    });
}
async function bindLane(
    meta: TokenMeta, lane: Lane, options: CodexLaneAcquireOptions, inheritBinding = false,
): Promise<CodexAppLaneLease> {
    const client = meta.client;
    const stored = options.forceNew ? null : options.storedThreadId ?? null;
    const needsBinding = !lane.threadId || !!options.forceNew
        || (!inheritBinding && !!stored && stored !== lane.threadId);
    lane.state = 'busy'; lane.lastUsedAt = Date.now(); meta.host.lastUsedAt = lane.lastUsedAt;
    let resumedThread = false;
    try {
        if (needsBinding) {
            const threadOptions: CodexThreadOptions = {
                model: meta.model, effort: meta.effort, cwd: meta.cwd, fastMode: meta.fastMode,
                ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
            };
            if (stored) {
                try { lane.threadId = await client.resumeThread(lane.laneScope, stored, threadOptions); resumedThread = true; }
                catch (error) {
                    if (!isRecoverableResumeError((error as Error).message)) throw error;
                    lane.threadId = await client.startThread(lane.laneScope, threadOptions);
                }
            } else lane.threadId = await client.startThread(lane.laneScope, threadOptions);
            lane.bindingEpoch = nextBindingEpoch++;
            // A reset that arrived while this binding was being established keeps its mark,
            // whatever the binding produced. A freshly started thread looks empty for exactly
            // as long as it takes this acquisition to hand it to the turn that was already
            // waiting for it, and that turn runs after the reset. Treating "started" as
            // "nothing to discard" therefore preserved a conversation created after the
            // compact reported one, and handed the next request's bootstrap into it.
        }
        assertCurrent(meta);
        const threadId = lane.threadId;
        if (!threadId) throw stale('Codex App lane has no thread binding');
        let released = false;
        return {
            client, scopeKey: lane.scopeKey, laneScope: lane.laneScope, bucketKey: options.bucketKey,
            threadId, laneMode: meta.laneMode, reused: !needsBinding, resumedThread,
            release: () => {
                if (released) return; released = true;
                if (meta.host.state !== 'ready' || meta.host.generation !== meta.generation
                    || meta.host.lanes.get(lane.laneScope) !== lane || lane.state !== 'busy') return;
                // A reset that landed mid-turn could not drop this binding then, because
                // the turn was still using it. It is dropped here, before any waiter is
                // woken, so the next acquisition cannot continue a discarded conversation.
                consumeRevokedBinding(lane);
                lane.state = 'idle'; lane.lastUsedAt = Date.now(); meta.host.lastUsedAt = lane.lastUsedAt; wakeHead(lane);
            },
            cancel: async () => {
                assertCurrent(meta);
                try { await client.interruptTurn(lane.laneScope); }
                catch (error) { poisonLane(meta.host, lane, error as Error); throw error; }
            },
        };
    } catch (error) {
        if (meta.host.state === 'ready' && meta.host.lanes.get(lane.laneScope) === lane) {
            try { await client.closeScope(lane.laneScope); } catch { /* best-effort incomplete binding cleanup */ }
            const waiters = lane.waiters.splice(0); removeLane(meta.host, lane);
            if (waiters.length > 0) wakeHead(createLane(meta.host, meta, lane.scopeKey, waiters));
        }
        throw error;
    }
}
async function acquireValidated(meta: TokenMeta, options: CodexLaneAcquireOptions): Promise<CodexAppLaneLease> {
    const laneScope = resolveCodexAppLaneKey(options.scopeKey, meta.model, meta.effort, meta.laneMode);
    const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
    let priority = false, waited = false, enqueuedEpoch = 0;
    for (;;) {
        try { assertCurrent(meta); }
        catch (error) {
            const lane = meta.host.lanes.get(laneScope);
            if (priority && lane?.handoff) { lane.handoff = false; wakeHead(lane); }
            throw error;
        }
        let lane = meta.host.lanes.get(laneScope);
        if (!lane) lane = createLane(meta.host, meta, options.scopeKey);
        if (lane.initializedGeneration !== meta.generation) throw stale();
        if (lane.state === 'poisoned') throw new Error(`Codex App lane ${laneScope} is poisoned`);
        if (lane.state === 'idle' && (!lane.handoff || priority)) {
            if (priority) lane.handoff = false;
            return bindLane(meta, lane, options, waited && lane.bindingEpoch !== enqueuedEpoch);
        }
        priority = false;
        if (!waited) { enqueuedEpoch = lane.bindingEpoch; waited = true; }
        await waitForLane(lane, deadline - Date.now());
        priority = true;
    }
}
export function acquireCodexAppLane(prepared: PreparedCodexAppHost, options: CodexLaneAcquireOptions): Promise<CodexAppLaneLease> {
    const meta = consumeToken(prepared, options);
    return acquireValidated(meta, options);
}

// Drop a scope's thread bindings so its next acquisition starts a new thread.
//
// Deleting the scope's session_buckets rows is not enough on its own. A lane that is
// idle rather than gone still holds `threadId` in memory, and bindLane() only rebinds
// when the lane has no thread, when forceNew is set, or when a STORED thread disagrees
// with it. After a compact there is no stored thread to disagree, so the lane is reused
// and the conversation the user just discarded continues — with the fresh bootstrap
// injected into it (072 §1.2b).
//
// A lane that is running cannot have its binding pulled out from under the turn using
// it, so it is MARKED and dropped on release instead. Skipping it outright was wrong:
// the busy check that guards the explicit command reads the default scope rather than
// the caller's, so a local session really can compact while its own lane is running,
// and release preserves threadId, so the discarded conversation would come back.
//
// Returns how many bindings were dropped or marked.
export function invalidateCodexAppLanesForScope(scopeKey: string | null): number {
    let dropped = 0;
    for (const host of hosts.values()) {
        for (const lane of host.lanes.values()) {
            // A null scope means every scope, which is what an instance-wide reset wants.
            if (scopeKey !== null && lane.scopeKey !== scopeKey) continue;
            // A busy lane is marked even when it has no thread yet: bindLane() flips the
            // lane to busy BEFORE awaiting startThread, so a reset arriving during that
            // await would otherwise be skipped and the thread it is about to establish
            // would outlive the reset that was supposed to discard it.
            if (lane.state === 'busy') { lane.bindingRevoked = true; dropped += 1; continue; }
            if (!lane.threadId) continue;
            lane.threadId = null;
            lane.bindingEpoch = nextBindingEpoch++;
            dropped += 1;
        }
    }
    return dropped;
}
export function codexAppHostPoolStats(): { hosts: number; creatingHosts: number; lanes: number; busyLanes: number; closing: boolean } {
    let creatingHosts = 0; let lanes = 0; let busyLanes = 0;
    for (const host of hosts.values()) {
        if (host.state === 'creating') creatingHosts += 1;
        lanes += host.lanes.size;
        for (const lane of host.lanes.values()) if (lane.state === 'busy') busyLanes += 1;
    }
    return { hosts: hosts.size, creatingHosts, lanes, busyLanes, closing };
}
function delay(ms: number): Promise<void> { return new Promise((done) => { setTimeout(done, ms); }); }
async function runShutdown(deadlineAt: number, reserveMs: number, reason: string): Promise<void> {
    const owned = [...new Set([...hosts.values(), ...closingHosts])].filter((host) => host.state !== 'dead');
    for (const host of owned) {
        host.state = 'closing'; host.rejectFailure(new CodexHostPoolClosingError(reason));
        for (const lane of host.lanes.values()) rejectWaiters(lane, new CodexHostPoolClosingError(reason));
    }
    const closes = owned.map(async (host) => {
        const pending = host.maintenance;
        if (pending) { try { await pending; } catch { /* maintenance failure is handled by the bounded kill */ } }
        if (host.state === 'dead') return;
        try { await host.client?.closeGracefully(); } catch { /* bounded kill below */ }
    });
    const allClosed = Promise.allSettled(closes);
    let settled = false; void allClosed.then(() => { settled = true; });
    const gracefulMs = Math.max(0, deadlineAt - Date.now() - reserveMs);
    if (gracefulMs > 0) await Promise.race([allClosed, delay(gracefulMs)]); else await Promise.resolve();
    if (!settled) for (const host of owned) host.client?.kill();
    const remaining = Math.max(0, deadlineAt - Date.now());
    if (!settled && remaining > 0) await Promise.race([allClosed, delay(remaining)]);
    for (const host of owned) invalidateHost(host, new CodexHostPoolClosingError(reason));
    hosts.clear(); closingHosts.clear(); tokenMetadata = new WeakMap();
}
export function shutdownCodexAppHostPool(options: CodexHostPoolShutdownOptions): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    if (reaper) { clearInterval(reaper); reaper = null; }
    const reserveMs = Math.max(0, options.reserveMs ?? 0);
    shutdownPromise = runShutdown(options.deadlineAt, reserveMs, options.reason ?? 'Codex App host pool shutdown');
    return shutdownPromise;
}
