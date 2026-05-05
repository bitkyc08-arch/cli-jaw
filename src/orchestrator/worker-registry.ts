// ─── Worker Registry ────────────────────────────────
// In-memory registry tracking worker ownership and result handoff.

import { stripUndefined } from '../core/strip-undefined.js';

const workers = new Map<string, WorkerSlot>();

// Replay metadata captured when Boss dispatches the worker. Used by
// drainPendingReplays so that when a disconnected employee's result is later
// delivered, it reaches the ORIGINAL channel (web/telegram/discord/chatId)
// rather than defaulting to a generic 'system' origin.
export interface WorkerReplayMeta {
    origin?: string;
    target?: string;
    chatId?: string | number;
    requestId?: string;
    scopeId?: string;
}

export interface WorkerSlot {
    agentId: string;          // same key used in spawn.ts activeProcesses
    employeeId: string;
    employeeName: string;
    task: string;
    phase: string | null;
    phaseLabel: string | null;
    state: 'running' | 'done' | 'failed' | 'cancelled';
    startedAt: number;
    completedAt: number | null;
    pendingReplay: boolean;
    replayClaimed: boolean;
    replayAttempts: number;
    result: string | null;
    /** Origin/target/chatId of the Boss session that dispatched this worker. */
    replayMeta?: WorkerReplayMeta;
}

// Phase 7: thrown when a worker slot with the same agentId is already running.
// Prevents double-dispatch from overwriting the in-flight slot and losing results.
export class WorkerBusyError extends Error {
    public existing: WorkerSlot;
    constructor(existing: WorkerSlot) {
        super(`Worker ${existing.employeeName} already running (task="${existing.task.slice(0, 60)}")`);
        this.name = 'WorkerBusyError';
        this.existing = existing;
    }
}

export interface WorkerEmployeeRef { id: string; name?: string }

export function claimWorker(emp: WorkerEmployeeRef, task: string, replayMeta?: WorkerReplayMeta): WorkerSlot {
    const existing = workers.get(emp.id);
    if (existing && existing.state === 'running') {
        throw new WorkerBusyError(existing);
    }
    const slot: WorkerSlot = stripUndefined({
        agentId: emp.id,
        employeeId: emp.id,
        employeeName: emp.name || emp.id,
        task,
        phase: null,
        phaseLabel: null,
        state: 'running',
        startedAt: Date.now(),
        completedAt: null,
        pendingReplay: false,
        replayClaimed: false,
        replayAttempts: 0,
        result: null,
        replayMeta: replayMeta && Object.keys(replayMeta).length ? { ...replayMeta } : undefined,
    });
    workers.set(emp.id, slot);
    return slot;
}

export function getWorkerSlot(agentId: string): WorkerSlot | undefined {
    return workers.get(agentId);
}

export function updateWorkerPhase(agentId: string, phase: string, phaseLabel: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.phase = phase;
    slot.phaseLabel = phaseLabel;
}

export function finishWorker(agentId: string, result: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.state = 'done';
    slot.completedAt = Date.now();
    slot.result = result;
    slot.pendingReplay = true;
}

export function failWorker(agentId: string, result: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.state = 'failed';
    slot.completedAt = Date.now();
    slot.result = result;
    slot.pendingReplay = false;  // Failed workers don't need replay — no result to feed back to Boss
}

export function cancelWorker(agentId: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.state = 'cancelled';
    slot.completedAt = Date.now();
    slot.pendingReplay = false;
    workers.delete(agentId);
}

export function getActiveWorkers(): WorkerSlot[] {
    return [...workers.values()].filter((slot) => slot.state === 'running');
}

export function hasBlockingWorkers(): boolean {
    for (const slot of workers.values()) {
        if (slot.state === 'running') return true;
    }
    return false;
}

export function hasPendingWorkerReplays(): boolean {
    for (const slot of workers.values()) {
        if (slot.pendingReplay) return true;
    }
    return false;
}

export function listPendingWorkerResults(): Array<{ agentId: string; text: string; meta?: WorkerReplayMeta }> {
    const results: Array<{ agentId: string; text: string; meta?: WorkerReplayMeta }> = [];
    for (const slot of workers.values()) {
        if (slot.state === 'done' && slot.pendingReplay && !slot.replayClaimed && slot.result !== null) {
            results.push(stripUndefined({ agentId: slot.agentId, text: slot.result, meta: slot.replayMeta }));
        }
    }
    return results;
}

export function claimWorkerReplay(agentId: string): boolean {
    const slot = workers.get(agentId);
    if (!slot || !slot.pendingReplay || slot.replayClaimed) return false;
    slot.replayClaimed = true;
    return true;
}

export function markWorkerReplayed(agentId: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.pendingReplay = false;
    slot.replayClaimed = false;
    if (slot.state !== 'running') workers.delete(agentId);
}

export function releaseWorkerReplay(agentId: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.replayClaimed = false;
    slot.replayAttempts++;
    if (slot.replayAttempts >= 3) {
        console.error(`[worker-registry] ${agentId} replay failed 3 times — marking as failed`);
        slot.state = 'failed';
        slot.pendingReplay = false;
    }
}

export function clearAllWorkers(): void {
    workers.clear();
}
