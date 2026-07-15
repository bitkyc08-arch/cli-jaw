import type { TerminalBridgeApi } from '../../providers/desktop-bridge-contract.ts';
import { TerminalPreBindBuffer } from './terminal-prebind-buffer.ts';
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
    private rejection: string | null = null;
    private disposed = false;

    constructor(
        private readonly bridge: TerminalBridgeApi,
        private readonly runtimeFactory: TerminalRuntimeFactory,
    ) {
        this.unsubscribeData = bridge.onData((id, data) => this.handleData(id, data));
        this.unsubscribeExit = bridge.onExit((id, code) => this.handleExit(id, code));
    }

    getSnapshot(): TerminalSessionSnapshot {
        return {
            sessions: this.sessions.map(cloneSession),
            activeSessionKey: this.activeSessionKey,
            creating: this.pendingCreate !== null,
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
        this.target = null;
        this.queuedNewSessions = 0;
        this.queuedRestarts.length = 0;
        this.rejection = null;
        this.teardownAllSessions();
        this.target = target ? { ...target } : null;
        this.notify();
        return true;
    }

    requestNewSessions(count = 1): void {
        if (this.disposed || !this.target || count <= 0) return;
        const requested = Math.floor(count);
        const capacity = Math.max(
            0,
            MAX_TERMINAL_SESSIONS - this.sessions.length - this.queuedNewSessions,
        );
        const accepted = Math.min(requested, capacity);
        this.queuedNewSessions += accepted;
        if (accepted < requested) {
            this.rejection = `Terminal session limit reached (${MAX_TERMINAL_SESSIONS}). Close a session before opening another.`;
        } else {
            this.rejection = null;
        }
        this.notify();
        this.drainCreateQueue();
    }

    activateSession(key: string): void {
        if (!this.sessions.some((session) => session.key === key)) return;
        this.activeSessionKey = key;
        this.notify();
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
        this.queuedRestarts.splice(0, this.queuedRestarts.length, ...this.queuedRestarts.filter((queued) => queued !== key));
        this.teardownSession(session);
        this.notify();
        this.drainCreateQueue();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.targetEpoch += 1;
        this.target = null;
        this.queuedNewSessions = 0;
        this.queuedRestarts.length = 0;
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
        if (this.disposed || this.pendingCreate || !this.target) return;
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
            createPromise = this.bridge.create({ cwd: target.cwd, cols: dimensions.cols, rows: dimensions.rows });
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
            void this.bridge.kill(result.id);
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

    private handleData(id: string, data: string): void {
        const key = this.keyBySessionId.get(id);
        if (key && !this.tombstones.has(key)) {
            this.runtimes.get(key)?.write(data);
            return;
        }
        this.pendingCreate?.preBind.captureData(id, data);
    }

    private handleExit(id: string, code: number | null): void {
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
