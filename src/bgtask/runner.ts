// ─── bgtask: runner (child process + session probe) ──
// Owns long-running work on behalf of the server. Child mode spawns an argv
// command (no shell) and parses stdout lines for completion; probe mode
// (session-status) polls the native web-ai session store read-only.
// On terminal transition the runner persists a raw capture via markTerminal
// and invokes the onTerminal callback (wired to the notifier by callers) —
// runner never imports notifier/gateway, keeping the dependency one-way.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
    BGTASK_DEFAULT_STALL_MS,
    BGTASK_PROBE_INTERVAL_MS,
    BGTASK_DEFAULT_MAX_RESULT_CHARS,
    BGTASK_STDERR_RING_LINES,
    type BgTaskRow,
    type BgTaskSpec,
} from './types.js';
import { getTask, markTerminal, markCancelled, setTaskPid } from './registry.js';
import { log } from '../core/logger.js';
import { ownProcess, type OwnedProcess, type OwnedProcessOptions, type ProcessTerminationReason } from '../agent/spawn/process-kill.js';

/** Raw capture persisted as the result column on terminal transition.
 * The notifier's resultExtractor turns this into the final {{result}} text. */
export interface BgTaskCapture {
    matchedLine?: string;
    stdoutTail: string[];
    stderrTail: string[];
    exitCode?: number | null;
    reason?: string;
    sessionStatus?: string;
}

export type TerminalCallback = (taskId: string) => void;

export type BgTaskRunnerOptions = {
    spawnImpl?: typeof spawn;
    ownedProcessOptions?: Omit<OwnedProcessOptions, 'policy'>;
};

interface RunnerHandle {
    taskId: string;
    mode: 'child' | 'probe';
    child?: ChildProcess;
    ownedChild?: OwnedProcess;
    probeTimer?: ReturnType<typeof setInterval>;
    stallTimer?: ReturnType<typeof setInterval>;
    deadlineTimer?: ReturnType<typeof setTimeout>;
    lastActivity: number;
    respawned: boolean;
    finished: boolean;
    onTerminal: TerminalCallback;
    options: BgTaskRunnerOptions;
}

const STDOUT_RING_LINES = 200;
const STALL_CHECK_INTERVAL_MS = 5_000;

const activeRunners = new Map<string, RunnerHandle>();

export function isTaskRunnerActive(taskId: string): boolean {
    return activeRunners.has(taskId);
}

export function listActiveRunnerIds(): string[] {
    return [...activeRunners.keys()];
}

export function startTask(row: BgTaskRow, onTerminal: TerminalCallback, options: BgTaskRunnerOptions = {}): void {
    if (activeRunners.has(row.id)) return;
    if (row.status !== 'running') return;
    if (row.spec.completion.type === 'session-status') {
        startProbe(row, onTerminal);
    } else {
        startChild(row, onTerminal, false, options);
    }
}

/** Cancel a task: persist the cancelled state first, then tear down the runner.
 * markCancelled guards the exit handler from double-transitioning. */
export function cancelTask(taskId: string): boolean {
    const changed = markCancelled(taskId);
    teardown(taskId, 'cancel');
    return changed;
}

/** Graceful-shutdown teardown: kill children and clear timers, but leave DB
 * rows as 'running' so boot recovery re-attaches or orphans them. */
export function stopAllBgTasks(): void {
    for (const taskId of [...activeRunners.keys()]) teardown(taskId, 'shutdown');
}

// ─── child mode ──────────────────────────────────────

function startChild(row: BgTaskRow, onTerminal: TerminalCallback, isRespawn: boolean, options: BgTaskRunnerOptions): void {
    const spec = row.spec;
    const command = spec.command ?? [];
    if (command.length === 0) {
        finishTask(row.id, 'failed', { stdoutTail: [], stderrTail: [], reason: 'empty command' }, onTerminal);
        return;
    }

    const handle: RunnerHandle = {
        taskId: row.id,
        mode: 'child',
        lastActivity: Date.now(),
        respawned: isRespawn,
        finished: false,
        onTerminal,
        options,
    };
    activeRunners.set(row.id, handle);

    const stdoutTail: string[] = [];
    const stderrTail: string[] = [];
    let matchedLine: string | undefined;

    let child: ChildProcess;
    try {
        child = (options.spawnImpl ?? spawn)(command[0]!, command.slice(1), {
            cwd: spec.cwd,
            env: spec.env ? { ...process.env, ...spec.env } : process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        activeRunners.delete(row.id);
        finishTask(row.id, 'failed', {
            stdoutTail, stderrTail,
            reason: `spawn failed: ${(err as Error).message}`,
        }, onTerminal);
        return;
    }
    handle.ownedChild = ownProcess(child, {
        ...options.ownedProcessOptions,
        policy: reason => reason === 'stall'
            ? { initialSignal: 'SIGKILL', graceMs: null }
            : { initialSignal: 'SIGTERM', graceMs: 2_000 },
    });
    handle.child = child;
    if (child.pid) setTaskPid(row.id, child.pid);

    const pushRing = (ring: string[], line: string, max: number) => {
        ring.push(line.slice(0, 2000));
        if (ring.length > max) ring.shift();
    };

    if (child.stdout) {
        createInterface({ input: child.stdout }).on('line', (line) => {
            handle.lastActivity = Date.now();
            pushRing(stdoutTail, line, STDOUT_RING_LINES);
            if (handle.finished || matchedLine !== undefined) return;
            if (lineMatchesCompletion(spec, line)) {
                matchedLine = line;
                // Terminal on match — most watchers exit on their own right
                // after the terminal line; kill covers the ones that linger.
                settle(handle, 'complete', { matchedLine, stdoutTail, stderrTail }, 'completion');
            }
        });
    }
    if (child.stderr) {
        createInterface({ input: child.stderr }).on('line', (line) => {
            handle.lastActivity = Date.now();
            pushRing(stderrTail, line, BGTASK_STDERR_RING_LINES);
        });
    }

    child.on('error', (err) => {
        settle(handle, 'failed', { stdoutTail, stderrTail, reason: `process error: ${err.message}` });
    });

    child.on('exit', (code) => {
        if (handle.finished) {
            cleanupHandle(handle);
            return;
        }
        if (spec.completion.type === 'exit') {
            settle(handle, code === 0 ? 'complete' : 'failed', { stdoutTail, stderrTail, exitCode: code });
        } else {
            // json-line / line-pattern: process ended without the terminal line.
            settle(handle, 'failed', {
                stdoutTail, stderrTail, exitCode: code,
                reason: 'process exited before completion line matched',
            });
        }
    });

    armStallTimer(handle, row, () => ({ stdoutTail, stderrTail }));
    armDeadlineTimer(handle, row, () => ({ stdoutTail, stderrTail }));
}

function lineMatchesCompletion(spec: BgTaskSpec, line: string): boolean {
    const completion = spec.completion;
    if (completion.type === 'json-line') {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return Object.entries(completion.match).every(([k, v]) => {
                const actual = parsed[k];
                if (typeof v === 'string' && v.endsWith('*')) {
                    return typeof actual === 'string' && actual.startsWith(v.slice(0, -1));
                }
                return actual === v;
            });
        } catch {
            return false;
        }
    }
    if (completion.type === 'line-pattern') {
        try {
            return new RegExp(completion.regex).test(line);
        } catch {
            return false;
        }
    }
    return false;
}

// ─── probe mode (web-ai session-status) ──────────────

const PROBE_TERMINAL_STATUSES = new Set(['complete', 'timeout', 'error']);

function startProbe(row: BgTaskRow, onTerminal: TerminalCallback): void {
    if (row.spec.completion.type !== 'session-status') return;
    const sessionId = row.spec.completion.sessionId;
    const handle: RunnerHandle = {
        taskId: row.id,
        mode: 'probe',
        lastActivity: Date.now(),
        respawned: false,
        finished: false,
        onTerminal,
        options: {},
    };
    activeRunners.set(row.id, handle);

    const tick = async () => {
        if (handle.finished) return;
        try {
            // Lazy import keeps src/bgtask free of browser-module load cost at boot.
            const session = await import('../browser/web-ai/session.js');
            const record = session.getSession(sessionId);
            if (!record) {
                settle(handle, 'failed', { stdoutTail: [], stderrTail: [], reason: `web-ai session not found: ${sessionId}` });
                return;
            }
            handle.lastActivity = Date.now();
            const status = String(record.status || '');
            if (PROBE_TERMINAL_STATUSES.has(status)) {
                settle(handle, status === 'complete' ? 'complete' : 'failed', {
                    stdoutTail: [], stderrTail: [], sessionStatus: status,
                });
            }
        } catch (err) {
            settle(handle, 'failed', {
                stdoutTail: [], stderrTail: [],
                reason: `probe error: ${(err as Error).message}`,
            });
        }
    };
    handle.probeTimer = setInterval(() => { void tick(); }, probeIntervalMs(row.spec));
    handle.probeTimer.unref?.();
    armDeadlineTimer(handle, row, () => ({ stdoutTail: [], stderrTail: [] }));
    void tick();
}

function probeIntervalMs(spec: BgTaskSpec): number {
    const v = Number(spec.stallAfterMs ? Math.min(spec.stallAfterMs, BGTASK_PROBE_INTERVAL_MS) : BGTASK_PROBE_INTERVAL_MS);
    return Math.max(250, v);
}

// ─── shared timers + settle ──────────────────────────

function armStallTimer(handle: RunnerHandle, row: BgTaskRow, capture: () => Pick<BgTaskCapture, 'stdoutTail' | 'stderrTail'>): void {
    const stallAfterMs = row.spec.stallAfterMs ?? BGTASK_DEFAULT_STALL_MS;
    if (!(stallAfterMs > 0)) return;
    handle.stallTimer = setInterval(() => {
        if (handle.finished) return;
        if (Date.now() - handle.lastActivity <= stallAfterMs) return;
        const fresh = getTask(row.id);
        if (!fresh || fresh.status !== 'running') {
            teardown(row.id);
            return;
        }
        if (row.spec.respawn === true && !handle.respawned) {
            handle.ownedChild?.terminate('stall');
            log.warn(`[bgtask:${row.id}] stalled ${stallAfterMs}ms — respawning once`);
            cleanupHandle(handle);
            activeRunners.delete(row.id);
            handle.finished = true;
            startChild(fresh, handle.onTerminal, true, handle.options);
            return;
        }
        settle(handle, 'failed', { ...capture(), reason: `stalled: no output for ${stallAfterMs}ms` }, 'stall');
    }, Math.min(STALL_CHECK_INTERVAL_MS, Math.max(50, Math.floor(stallAfterMs / 2))));
    handle.stallTimer.unref?.();
}

function armDeadlineTimer(handle: RunnerHandle, row: BgTaskRow, capture: () => Pick<BgTaskCapture, 'stdoutTail' | 'stderrTail'>): void {
    const deadlineAt = Date.parse(row.deadlineAt ?? row.spec.deadlineAt ?? '');
    if (!Number.isFinite(deadlineAt)) return;
    const delay = deadlineAt - Date.now();
    if (delay <= 0) {
        settle(handle, 'failed', { ...capture(), reason: 'deadline exceeded' }, 'timeout');
        return;
    }
    handle.deadlineTimer = setTimeout(() => {
        settle(handle, 'failed', { ...capture(), reason: 'deadline exceeded' }, 'timeout');
    }, delay);
    handle.deadlineTimer.unref?.();
}

/** Single terminal path: persist capture, tear down, fire onTerminal exactly once. */
function settle(
    handle: RunnerHandle,
    status: 'complete' | 'failed',
    capture: BgTaskCapture,
    reason: ProcessTerminationReason = 'shutdown',
): void {
    if (handle.finished) return;
    handle.finished = true;
    handle.ownedChild?.terminate(reason);
    finishTask(handle.taskId, status, capture, handle.onTerminal);
    teardown(handle.taskId, reason);
}

function finishTask(taskId: string, status: 'complete' | 'failed', capture: BgTaskCapture, onTerminal: TerminalCallback): void {
    const raw = JSON.stringify(capture);
    const truncated = raw.length > BGTASK_DEFAULT_MAX_RESULT_CHARS
        ? JSON.stringify({ ...capture, stdoutTail: capture.stdoutTail.slice(-20), stderrTail: capture.stderrTail.slice(-20), truncated: true })
        : raw;
    const transitioned = markTerminal(taskId, status, truncated);
    if (!transitioned) return; // cancelled or already terminal — never double-notify
    try {
        onTerminal(taskId);
    } catch (err) {
        log.error(`[bgtask:${taskId}] onTerminal callback failed:`, (err as Error).message);
    }
}

function cleanupHandle(handle: RunnerHandle): void {
    if (handle.stallTimer) clearInterval(handle.stallTimer);
    if (handle.probeTimer) clearInterval(handle.probeTimer);
    if (handle.deadlineTimer) clearTimeout(handle.deadlineTimer);
}

function teardown(taskId: string, reason: ProcessTerminationReason = 'shutdown'): void {
    const handle = activeRunners.get(taskId);
    if (!handle) return;
    handle.finished = true;
    cleanupHandle(handle);
    handle.ownedChild?.terminate(reason);
    activeRunners.delete(taskId);
}
