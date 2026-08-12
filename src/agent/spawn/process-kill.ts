import { execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Recursively kill a process tree using pgrep -P.
 * Codex sub-agents spawn children with separate PGIDs,
 * so process.kill(-pid) won't reach them.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
        return;
    }
    let childPids: number[] = [];
    try {
        const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 3000 });
        childPids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => n > 0);
    } catch { /* no children or pgrep failed */ }
    for (const cpid of childPids) {
        killProcessTree(cpid, signal);
    }
    try { process.kill(pid, signal); } catch { /* already dead */ }
}

/**
 * Has this child already exited?
 *
 * `ChildProcess.killed` only records that a signal was delivered, so it is not a
 * liveness test: a process can be `killed === true` and still running. Node sets
 * exactly one of `exitCode`/`signalCode` once the process is reaped.
 */
export function hasChildExited(child: ChildProcess | null | undefined): boolean {
    if (!child) return true;
    return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Escalate to SIGKILL only while the child is still running.
 *
 * A delayed escalation must never fire blind: if the child exited during the
 * grace period, the OS may already have reassigned its PID, and because
 * `killProcessTree` walks `pgrep -P` it would take an unrelated process tree
 * down with it.
 */
export function killProcessTreeIfAlive(
    child: ChildProcess | null | undefined,
    pid?: number,
    terminateTree: typeof killProcessTree = killProcessTree,
): void {
    if (hasChildExited(child)) return;
    const target = pid ?? child?.pid;
    if (!target) return;
    try { terminateTree(target, 'SIGKILL'); } catch { /* already dead */ }
}

/** Why a child is being terminated. Chosen by the owner that spawned it. */
export type ProcessTerminationReason =
    | 'cancel' | 'timeout' | 'stall' | 'shutdown' | 'startup-failed'
    | 'output-limit' | 'completion' | 'duplicate-registration' | 'steer';

export type ProcessTerminationPolicy = {
    initialSignal: NodeJS.Signals;
    /** Delay before SIGKILL escalation, or null for no escalation. */
    graceMs: number | null;
};

export type OwnedProcessOptions = {
    policy?: (reason: ProcessTerminationReason) => ProcessTerminationPolicy;
    terminateTree?: typeof killProcessTree;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
};

function defaultPolicy(reason: ProcessTerminationReason): ProcessTerminationPolicy {
    return {
        initialSignal: 'SIGTERM',
        // Preserves the existing generic watchdog grace in spawn.ts. Owners with
        // stricter semantics (bgtask's stall kill) pass their own policy.
        graceMs: reason === 'stall' ? 5_000 : 2_000,
    };
}

/**
 * Lifetime ownership for one spawned child.
 *
 * Composition over the helpers above, not a second tree algorithm. The problem
 * it solves is that termination logic was duplicated across timeout, cancel,
 * shutdown, and startup-failure paths, so each owner re-derived escalation and
 * some forgot the tree entirely.
 *
 * Invariants:
 *   - the PID is captured ONCE at construction and never retargeted, so a
 *     delayed escalation can never hit a recycled PID;
 *   - the first termination reason wins;
 *   - `terminate()` and `complete()` are idempotent;
 *   - escalation re-checks the ORIGINAL child before firing.
 *
 * Honest limit: Node cannot spawn suspended and assign a Job Object, so a
 * descendant that escapes before the first tree walk is not guaranteed
 * contained. See devlog/_plan/260812_windows_and_channels_parity/050.
 */
export class OwnedProcess {
    readonly child: ChildProcess;
    readonly pid: number | undefined;
    #options: OwnedProcessOptions;
    #state: 'running' | 'terminating' | 'complete' = 'running';
    #reason: ProcessTerminationReason | null = null;
    #escalation: ReturnType<typeof setTimeout> | null = null;

    constructor(child: ChildProcess, options: OwnedProcessOptions = {}) {
        this.child = child;
        this.pid = child.pid;
        this.#options = options;
        child.once('exit', () => this.complete());
        child.once('error', () => this.complete());
    }

    get reason(): ProcessTerminationReason | null { return this.#reason; }
    get state(): 'running' | 'terminating' | 'complete' { return this.#state; }

    terminate(reason: ProcessTerminationReason): void {
        if (this.#state !== 'running') return;
        this.#state = 'terminating';
        this.#reason = reason;
        if (!this.pid || hasChildExited(this.child)) {
            this.complete();
            return;
        }

        const terminateTree = this.#options.terminateTree ?? killProcessTree;
        const policy = this.#options.policy?.(reason) ?? defaultPolicy(reason);
        try { terminateTree(this.pid, policy.initialSignal); } catch { /* best effort */ }
        if (policy.graceMs === null || policy.initialSignal === 'SIGKILL') return;

        const setTimer = this.#options.setTimer ?? setTimeout;
        this.#escalation = setTimer(() => {
            this.#escalation = null;
            killProcessTreeIfAlive(this.child, this.pid, terminateTree);
        }, policy.graceMs);
        this.#escalation.unref?.();
    }

    /** The child settled (or we no longer own it). Cancels pending escalation. */
    complete(): void {
        if (this.#state === 'complete') return;
        this.#state = 'complete';
        if (this.#escalation) {
            (this.#options.clearTimer ?? clearTimeout)(this.#escalation);
            this.#escalation = null;
        }
    }
}

const ownedProcesses = new WeakMap<ChildProcess, OwnedProcess>();

/**
 * Obtain the owner for a child, creating it on first call.
 *
 * Memoized by ChildProcess identity so a concrete owner and generic
 * bookkeeping can never install competing escalation timers. The FIRST call
 * must therefore sit next to the real spawn, where the correct policy is known.
 */
export function ownProcess(child: ChildProcess, options?: OwnedProcessOptions): OwnedProcess {
    const existing = ownedProcesses.get(child);
    if (existing) return existing;
    const owned = new OwnedProcess(child, options);
    ownedProcesses.set(child, owned);
    return owned;
}
