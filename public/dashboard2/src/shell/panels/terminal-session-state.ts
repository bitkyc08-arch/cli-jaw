import type { TerminalBridgeApi } from '../../providers/desktop-bridge-contract.ts';
import { PRE_BIND_BUFFER_CAP, TerminalPreBindBuffer } from './terminal-prebind-buffer.ts';
export { PRE_BIND_BUFFER_CAP } from './terminal-prebind-buffer.ts';
export const MAX_TERMINAL_SESSIONS = 8;
const MAX_PRE_BIND_CANDIDATES = MAX_TERMINAL_SESSIONS;
export interface TerminalTarget {
    port: number;
    cwd: string;
}
export function terminalTargetMatches(port: number | null, target: TerminalTarget | null): target is TerminalTarget {
    return port !== null && target !== null && target.port === port;
}
export type TerminalSessionStatus = 'starting' | 'running' | 'exited' | 'error';

export interface TerminalSessionView {
    key: string;
    ordinal: number;
    sessionId: string | null;
    shell: string;
    cwd: string;
    status: TerminalSessionStatus;
    message: string;
}

export interface TerminalSessionSnapshot {
    sessions: TerminalSessionView[];
    activeSessionKey: string | null;
    creating: boolean;
    hydrating: boolean;
    queuedRequests: number;
    rejection: string | null;
}

export interface TerminalRuntime {
    open(host: HTMLElement): void;
    write(data: string): void;
    writeln(data: string): void;
    clear(): void;
    focus(): void;
    fit(): { cols: number; rows: number } | null;
    dispose(): void;
}

export type TerminalRuntimeFactory = (
    key: string,
    onInput: (data: string) => void,
) => TerminalRuntime;

type SnapshotListener = (snapshot: TerminalSessionSnapshot) => void;
type CreateResult = Awaited<ReturnType<TerminalBridgeApi['create']>>;

interface PendingCreate {
    key: string;
    epoch: number;
    target: TerminalTarget;
    preBind: TerminalPreBindBuffer;
}

interface PendingHydrate {
    epoch: number;
    target: TerminalTarget;
}

interface HydrateEventCandidate {
    chunks: Array<{ data: string; seq: number | undefined }>;
    exitSeen: boolean;
    exitCode: number | null;
}

const HYDRATE_EVENT_MAX_CANDIDATES = MAX_PRE_BIND_CANDIDATES;

// Output arriving between the list snapshot and rebind: replayed only when
// its seq is newer than the snapshot watermark (R1 dedupe).
class HydrateEventBuffer {
    private readonly candidates = new Map<string, HydrateEventCandidate>();

    captureData(id: string, data: string, seq: number | undefined): void {
        const candidate = this.candidate(id);
        if (!candidate) return;
        const buffered = candidate.chunks.reduce((total, chunk) => total + chunk.data.length, 0);
        if (buffered >= PRE_BIND_BUFFER_CAP) return;
        candidate.chunks.push({ data: data.slice(0, PRE_BIND_BUFFER_CAP - buffered), seq });
    }

    captureExit(id: string, code: number | null): void {
        const candidate = this.candidate(id);
        if (!candidate) return;
        candidate.exitSeen = true;
        candidate.exitCode = code;
    }

    take(id: string): HydrateEventCandidate | null {
        const candidate = this.candidates.get(id) ?? null;
        this.candidates.delete(id);
        return candidate;
    }

    clear(): void {
        this.candidates.clear();
    }

    private candidate(id: string): HydrateEventCandidate | null {
        const existing = this.candidates.get(id);
        if (existing) return existing;
        if (this.candidates.size >= HYDRATE_EVENT_MAX_CANDIDATES) return null;
        const candidate: HydrateEventCandidate = { chunks: [], exitSeen: false, exitCode: null };
        this.candidates.set(id, candidate);
        return candidate;
    }
}

function cloneSession(session: TerminalSessionView): TerminalSessionView {
    return { ...session };
}

export class TerminalSessionController {
    private readonly listeners = new Set<SnapshotListener>();
    private readonly runtimes = new Map<string, TerminalRuntime>();
    private readonly keyBySessionId = new Map<string, string>();
    private readonly tombstones = new Set<string>();
    private readonly queuedRestarts: string[] = [];
    private readonly unsubscribeData: () => void;
    private readonly unsubscribeExit: () => void;
    private sessions: TerminalSessionView[] = [];
    private activeSessionKey: string | null = null;
    private target: TerminalTarget | null = null;
    private targetEpoch = 0;
    private nextOrdinal = 1;
    private queuedNewSessions = 0;
    private pendingCreate: PendingCreate | null = null;
    private pendingHydrate: PendingHydrate | null = null;
    private readonly hydrateEvents = new HydrateEventBuffer();
    private hydrateError: string | null = null;
    private autoPending = false;
    private ownerSessionIds = new Set<string>();
    private rejection: string | null = null;
    private disposed = false;
    private closedAll = false;
    // Explicit user closes, tracked separately from park tombstones so a
    // detach cannot undo a close (D1).
    private readonly explicitlyClosedKeys = new Set<string>();
    // Locally killed ids: main-side kill emits no exit event, so hydration
    // must never re-seed or rebind a snapshot entry we already killed (E2).
    private readonly killedIds = new Set<string>();

    constructor(
        private readonly bridge: TerminalBridgeApi,
        private readonly runtimeFactory: TerminalRuntimeFactory,
    ) {
        this.unsubscribeData = bridge.onData((id, data, seq) => this.handleData(id, data, seq));
        this.unsubscribeExit = bridge.onExit((id, code) => this.handleExit(id, code));
    }

    getSnapshot(): TerminalSessionSnapshot {
        return {
            sessions: this.sessions.map(cloneSession),
            activeSessionKey: this.activeSessionKey,
            creating: this.pendingCreate !== null,
            hydrating: this.pendingHydrate !== null,
            queuedRequests: this.queuedNewSessions + this.queuedRestarts.length,
            rejection: this.rejection,
        };
    }

    subscribe(listener: SnapshotListener): () => void {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    setTarget(target: TerminalTarget | null): boolean {
        if (this.sameTarget(target)) return false;
        this.targetEpoch += 1;
        this.pendingHydrate = null;
        this.hydrateEvents.clear();
        this.hydrateError = null;
        this.autoPending = false;
        this.target = null;
        this.queuedNewSessions = 0;
        this.queuedRestarts.length = 0;
        this.rejection = null;
        this.parkAllSessions();
        this.target = target ? { ...target } : null;
        if (this.target) this.startHydrate(this.target);
        this.notify();
        return true;
    }

    requestNewSessions(count = 1): void {
        if (this.disposed || !this.target || count <= 0) return;
        const requested = Math.floor(count);
        if (this.hydrateError) {
            // Explicit user intent retries a failed hydration for this target.
            this.hydrateError = null;
            this.rejection = null;
            this.startHydrate(this.target);
        }
        if (this.pendingHydrate) {
            // Capacity is re-evaluated against owner-wide state after hydrate.
            this.queuedNewSessions += requested;
            this.notify();
            return;
        }
        const capacity = Math.max(
            0,
            MAX_TERMINAL_SESSIONS - this.ownerSessionIds.size - this.queuedNewSessions,
        );
        const accepted = Math.min(requested, capacity);
        this.queuedNewSessions += accepted;
        if (accepted < requested) {
            const parked = Math.max(0, this.ownerSessionIds.size - this.sessions.length);
            this.rejection = parked > 0
                ? `Terminal session limit reached (${MAX_TERMINAL_SESSIONS}, ${parked} parked on other instances). Close a session before opening another.`
                : `Terminal session limit reached (${MAX_TERMINAL_SESSIONS}). Close a session before opening another.`;
        } else {
            this.rejection = null;
        }
        this.notify();
        this.drainCreateQueue();
    }

    requestAutoSession(): void {
        if (this.disposed || !this.target || this.hydrateError) return;
        if (this.pendingHydrate) {
            this.autoPending = true;
            return;
        }
        if (this.sessions.length === 0 && this.queuedNewSessions === 0 && !this.pendingCreate) {
            this.requestNewSessions(1);
        }
    }

    activateSession(key: string): void {
        if (!this.sessions.some((session) => session.key === key)) return;
        this.activeSessionKey = key;
        this.notify();
    }

    focusActive(): void {
        if (!this.activeSessionKey) return;
        const session = this.findSession(this.activeSessionKey);
        if (!session?.sessionId || session.status !== 'running') return;
        this.runtimes.get(this.activeSessionKey)?.focus();
    }

    attachHost(key: string, host: HTMLElement | null): void {
        if (!host || this.tombstones.has(key)) return;
        this.runtimes.get(key)?.open(host);
    }

    clearActive(): void {
        if (!this.activeSessionKey) return;
        this.runtimes.get(this.activeSessionKey)?.clear();
    }

    resizeActive(): void {
        if (!this.activeSessionKey) return;
        const session = this.findSession(this.activeSessionKey);
        const runtime = this.runtimes.get(this.activeSessionKey);
        if (!session?.sessionId || session.status !== 'running' || !runtime) return;
        const dimensions = runtime.fit();
        if (!dimensions || dimensions.cols <= 0 || dimensions.rows <= 0) return;
        void this.bridge.resize(session.sessionId, dimensions.cols, dimensions.rows);
    }

    restartSession(key: string): void {
        const session = this.findSession(key);
        if (!session || (session.status !== 'exited' && session.status !== 'error')) return;
        if (this.queuedRestarts.includes(key)) return;
        this.tombstones.delete(key);
        session.status = 'starting';
        session.message = `Restarting terminal in ${session.cwd}`;
        this.activeSessionKey = key;
        this.queuedRestarts.push(key);
        this.notify();
        this.drainCreateQueue();
    }

    closeSession(key: string): void {
        const session = this.findSession(key);
        if (!session) return;
        this.explicitlyClosedKeys.add(key);
        if (session.sessionId) this.ownerSessionIds.delete(session.sessionId);
        this.queuedRestarts.splice(0, this.queuedRestarts.length, ...this.queuedRestarts.filter((queued) => queued !== key));
        this.teardownSession(session);
        this.notify();
        this.drainCreateQueue();
    }

    // Unmount/remount path: park local state without killing remote PTYs so a
    // later mount can hydrate them back (R5/S3: renderer never kills-all implicitly).
    detach(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.targetEpoch += 1;
        this.pendingHydrate = null;
        this.hydrateEvents.clear();
        this.target = null;
        this.queuedNewSessions = 0;
        this.queuedRestarts.length = 0;
        this.parkAllSessions();
        this.unsubscribeData();
        this.unsubscribeExit();
        this.listeners.clear();
    }

    // Explicit close-all: kills every session this owner holds in main,
    // including parked ones (manifest cap-recovery/close-all teardown).
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.closedAll = true;
        this.targetEpoch += 1;
        this.pendingHydrate = null;
        this.hydrateEvents.clear();
        this.target = null;
        this.queuedNewSessions = 0;
        this.queuedRestarts.length = 0;
        void this.bridge.list().then(result => {
            if (result.ok && result.sessions) {
                for (const entry of result.sessions) void this.bridge.kill(entry.id);
            }
        }).catch(() => { /* best-effort close-all */ });
        this.teardownAllSessions();
        this.unsubscribeData();
        this.unsubscribeExit();
        this.listeners.clear();
    }

    private sameTarget(target: TerminalTarget | null): boolean {
        if (!this.target || !target) return this.target === target;
        return this.target.port === target.port && this.target.cwd === target.cwd;
    }

    private notify(): void {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
    }

    private findSession(key: string): TerminalSessionView | undefined {
        return this.sessions.find((session) => session.key === key);
    }

    private createSessionShell(target: TerminalTarget): TerminalSessionView {
        const ordinal = this.nextOrdinal++;
        const session: TerminalSessionView = {
            key: `terminal-session-${ordinal}`,
            ordinal,
            sessionId: null,
            shell: 'shell',
            cwd: target.cwd,
            status: 'starting',
            message: `Starting terminal in ${target.cwd}`,
        };
        const runtime = this.runtimeFactory(session.key, (data) => this.handleInput(session.key, data));
        runtime.writeln('\x1b[1;36mcli-jaw terminal\x1b[0m');
        runtime.writeln(`Instance ${target.port}. Starting in ${target.cwd}...`);
        this.runtimes.set(session.key, runtime);
        this.sessions = [...this.sessions, session];
        this.activeSessionKey = session.key;
        return session;
    }

    private drainCreateQueue(): void {
        if (this.disposed || this.pendingCreate || this.pendingHydrate || !this.target) return;
        if (this.queuedNewSessions > 0 && this.ownerSessionIds.size >= MAX_TERMINAL_SESSIONS) {
            // Capacity is owner-wide and re-evaluated at drain time: queued
            // requests beyond the cap fail closed with a visible rejection.
            const parked = Math.max(0, this.ownerSessionIds.size - this.sessions.length);
            this.queuedNewSessions = 0;
            this.rejection = parked > 0
                ? `Terminal session limit reached (${MAX_TERMINAL_SESSIONS}, ${parked} parked on other instances). Close a session before opening another.`
                : `Terminal session limit reached (${MAX_TERMINAL_SESSIONS}). Close a session before opening another.`;
            this.notify();
            return;
        }
        const restartKey = this.queuedRestarts.shift();
        if (restartKey) {
            const restartSession = this.findSession(restartKey);
            if (restartSession && !this.tombstones.has(restartKey)) {
                this.beginCreate(restartSession, this.target);
                return;
            }
            this.drainCreateQueue();
            return;
        }
        if (this.queuedNewSessions <= 0) return;
        this.queuedNewSessions -= 1;
        const session = this.createSessionShell(this.target);
        this.notify();
        this.beginCreate(session, this.target);
    }

    private beginCreate(session: TerminalSessionView, target: TerminalTarget): void {
        const runtime = this.runtimes.get(session.key);
        if (!runtime) return;
        session.status = 'starting';
        session.message = `Starting terminal in ${target.cwd}`;
        this.activeSessionKey = session.key;
        const dimensions = runtime.fit() ?? { cols: 80, rows: 24 };
        const pending: PendingCreate = {
            key: session.key,
            epoch: this.targetEpoch,
            target: { ...target },
            preBind: new TerminalPreBindBuffer(MAX_PRE_BIND_CANDIDATES),
        };
        this.pendingCreate = pending;
        this.notify();
        let createPromise: ReturnType<TerminalBridgeApi['create']>;
        try {
            createPromise = this.bridge.create({ cwd: target.cwd, cols: dimensions.cols, rows: dimensions.rows, port: target.port });
        } catch (error: unknown) {
            this.finishCreate(pending, {
                ok: false,
                error: error instanceof Error ? error.message : 'Unable to create native terminal',
            });
            return;
        }
        void createPromise
            .then((result) => this.finishCreate(pending, result))
            .catch((error: unknown) => this.finishCreate(pending, {
                ok: false,
                error: error instanceof Error ? error.message : 'Unable to create native terminal',
            }));
    }

    private finishCreate(pending: PendingCreate, result: CreateResult): void {
        if (this.pendingCreate !== pending) return;
        const session = this.findSession(pending.key);
        const stale = this.disposed
            || pending.epoch !== this.targetEpoch
            || this.tombstones.has(pending.key)
            || !session
            || !this.sameTarget(pending.target);
        this.pendingCreate = null;

        if (!result.ok || !result.id) {
            if (!stale && session) {
                session.status = 'error';
                session.message = result.error ?? 'Unable to create native terminal';
                if (result.error === 'max sessions reached') {
                    this.rejection = `Terminal session limit reached (${MAX_TERMINAL_SESSIONS}). Close a session before opening another.`;
                }
                this.runtimes.get(session.key)?.writeln(session.message);
            }
            this.notify();
            this.drainCreateQueue();
            return;
        }

        if (stale || !session) {
            const explicitlyClosed = this.explicitlyClosedKeys.has(pending.key);
            const adoptedKey = this.keyBySessionId.get(result.id);
            // Explicit close always wins over adoption (E1); adoption only
            // preserves a live rebound session from its own late create (D2).
            const mustKill = explicitlyClosed
                || this.closedAll
                || (!this.disposed && !adoptedKey);
            if (mustKill) {
                this.killedIds.add(result.id);
                // Prune owner-wide accounting at the kill site: main-side
                // kill emits no exit event (C4).
                this.ownerSessionIds.delete(result.id);
                void this.bridge.kill(result.id);
                if (adoptedKey) {
                    const adoptedSession = this.findSession(adoptedKey);
                    this.keyBySessionId.delete(result.id);
                    if (adoptedSession) {
                        adoptedSession.sessionId = null;
                        this.applyExit(adoptedSession, null);
                    }
                }
            }
            // else: adopted live (preserve) or detached park (C3).
            this.notify();
            this.drainCreateQueue();
            return;
        }

        const runtime = this.runtimes.get(session.key);
        const candidate = pending.preBind.take(result.id);
        session.sessionId = result.id;
        session.shell = result.shell ?? 'shell';
        session.cwd = result.cwd ?? pending.target.cwd;
        this.keyBySessionId.set(result.id, session.key);
        if (candidate?.data) runtime?.write(candidate.data);

        if (candidate?.exitSeen) {
            this.keyBySessionId.delete(result.id);
            session.sessionId = null;
            this.applyExit(session, candidate.exitCode);
        } else {
            this.ownerSessionIds.add(result.id);
            session.status = 'running';
            session.message = session.cwd === pending.target.cwd
                ? `Terminal running in ${session.cwd}`
                : `Terminal requested ${pending.target.cwd}; running in ${session.cwd}`;
            if (session.cwd !== pending.target.cwd) runtime?.writeln(`[${session.message}]`);
            runtime?.focus();
        }
        pending.preBind.clear();
        this.notify();
        this.resizeActive();
        this.drainCreateQueue();
    }

    private handleInput(key: string, data: string): void {
        if (this.tombstones.has(key)) return;
        const session = this.findSession(key);
        if (session?.status === 'running' && session.sessionId) {
            void this.bridge.write(session.sessionId, data);
        }
    }

    private handleData(id: string, data: string, seq?: number): void {
        const key = this.keyBySessionId.get(id);
        if (key && !this.tombstones.has(key)) {
            this.runtimes.get(key)?.write(data);
            return;
        }
        if (this.pendingHydrate) {
            this.hydrateEvents.captureData(id, data, seq);
            return;
        }
        this.pendingCreate?.preBind.captureData(id, data);
    }

    private handleExit(id: string, code: number | null): void {
        // Always prune owner-wide accounting first: parked sessions exit too.
        this.ownerSessionIds.delete(id);
        const key = this.keyBySessionId.get(id);
        if (key && !this.tombstones.has(key)) {
            const session = this.findSession(key);
            if (!session) return;
            this.keyBySessionId.delete(id);
            session.sessionId = null;
            this.applyExit(session, code);
            this.notify();
            return;
        }
        if (this.pendingHydrate) {
            this.hydrateEvents.captureExit(id, code);
            return;
        }
        this.pendingCreate?.preBind.captureExit(id, code);
    }

    private applyExit(session: TerminalSessionView, code: number | null): void {
        const codeLabel = code === null ? 'unknown' : String(code);
        session.status = 'exited';
        session.message = `Terminal exited with code ${codeLabel}`;
        this.runtimes.get(session.key)?.writeln(`[process exited with code ${codeLabel}]`);
    }

    private teardownAllSessions(): void {
        const sessions = [...this.sessions];
        for (const session of sessions) this.teardownSession(session, false);
        this.sessions = [];
        this.activeSessionKey = null;
    }

    // Park: detach local runtimes/state while leaving remote PTYs alive in
    // main, so switching back to this target can hydrate them (B6 contract).
    private parkAllSessions(): void {
        for (const session of this.sessions) {
            this.tombstones.add(session.key);
            if (session.sessionId) this.keyBySessionId.delete(session.sessionId);
            session.sessionId = null;
            this.runtimes.get(session.key)?.dispose();
            this.runtimes.delete(session.key);
        }
        this.sessions = [];
        this.activeSessionKey = null;
    }

    private startHydrate(target: TerminalTarget): void {
        const epoch = this.targetEpoch;
        this.pendingHydrate = { epoch, target: { ...target } };
        this.hydrateEvents.clear();
        const finish = (apply: () => void): void => {
            if (!this.pendingHydrate || this.pendingHydrate.epoch !== epoch) return;
            this.pendingHydrate = null;
            apply();
            this.hydrateEvents.clear();
            this.notify();
            this.drainAfterHydrate();
        };
        void this.bridge.list().then(result => {
            finish(() => {
                if (!result.ok || !result.sessions) {
                    // Fail closed: surface the rejection, drop queued creates,
                    // and suppress auto-create until explicit retry (R3).
                    this.hydrateError = result.error ?? 'Unable to list terminal sessions';
                    this.rejection = this.hydrateError;
                    this.queuedNewSessions = 0;
                    this.autoPending = false;
                    return;
                }
                this.hydrateError = null;
                // Re-seed owner-wide accounting from the authoritative list,
                // minus anything we already killed locally (E2).
                this.ownerSessionIds = new Set(
                    result.sessions.filter(entry => !this.killedIds.has(entry.id)).map(entry => entry.id),
                );
                // Target identity is port+cwd: cross-cwd entries stay parked
                // for their own target (D2).
                const mine = result.sessions.filter(entry => !this.killedIds.has(entry.id)
                    && entry.port === target.port
                    && (entry.cwd === undefined || entry.cwd === target.cwd));
                for (const entry of mine) this.rebindSession(entry, target);
            });
        }).catch((error: unknown) => {
            finish(() => {
                this.hydrateError = error instanceof Error ? error.message : 'Unable to list terminal sessions';
                this.rejection = this.hydrateError;
                this.queuedNewSessions = 0;
                this.autoPending = false;
            });
        });
    }

    private rebindSession(entry: { id: string; shell?: string; cwd?: string; seq?: number; buffer?: string }, target: TerminalTarget): void {
        const ordinal = this.nextOrdinal++;
        const session: TerminalSessionView = {
            key: `terminal-session-${ordinal}`,
            ordinal,
            sessionId: entry.id,
            shell: entry.shell ?? 'shell',
            cwd: entry.cwd ?? target.cwd,
            status: 'running',
            message: `Terminal restored in ${entry.cwd ?? target.cwd}`,
        };
        const runtime = this.runtimeFactory(session.key, (data) => this.handleInput(session.key, data));
        this.runtimes.set(session.key, runtime);
        if (entry.buffer) runtime.write(entry.buffer);
        const candidate = this.hydrateEvents.take(entry.id);
        const snapshotSeq = entry.seq ?? Number.NEGATIVE_INFINITY;
        if (candidate) {
            // Only post-snapshot output replays (R1 seq watermark dedupe).
            for (const chunk of candidate.chunks) {
                if (chunk.seq === undefined || chunk.seq > snapshotSeq) runtime.write(chunk.data);
            }
        }
        this.sessions = [...this.sessions, session];
        if (!this.activeSessionKey) this.activeSessionKey = session.key;
        if (candidate?.exitSeen) {
            // The PTY died between snapshot and rebind: restore as exited (R4).
            session.sessionId = null;
            this.ownerSessionIds.delete(entry.id);
            this.applyExit(session, candidate.exitCode);
            return;
        }
        this.keyBySessionId.set(entry.id, session.key);
        session.status = 'running';
    }

    private drainAfterHydrate(): void {
        if (this.autoPending) {
            this.autoPending = false;
            if (this.sessions.length === 0 && this.queuedNewSessions === 0) {
                this.queuedNewSessions = 1;
            }
        }
        this.notify();
        this.drainCreateQueue();
    }

    private teardownSession(session: TerminalSessionView, remove = true): void {
        this.tombstones.add(session.key);
        const sessionId = session.sessionId;
        if (sessionId) this.keyBySessionId.delete(sessionId);
        session.sessionId = null;
        if (remove) {
            const index = this.sessions.findIndex((candidate) => candidate.key === session.key);
            const next = index >= 0 ? this.sessions[index + 1] ?? this.sessions[index - 1] ?? null : null;
            this.sessions = this.sessions.filter((candidate) => candidate.key !== session.key);
            if (this.activeSessionKey === session.key) this.activeSessionKey = next?.key ?? null;
        }
        if (sessionId) void this.bridge.kill(sessionId);
        this.runtimes.get(session.key)?.dispose();
        this.runtimes.delete(session.key);
    }
}
