// ─── Worker Registry ────────────────────────────────
// In-memory registry tracking worker ownership and result handoff.

const workers = new Map<string, WorkerSlot>();

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
    result: string | null;
}

export function claimWorker(emp: Record<string, any>, task: string): WorkerSlot {
    const slot: WorkerSlot = {
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
        result: null,
    };
    workers.set(emp.id, slot);
    return slot;
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

export function listPendingWorkerResults(): Array<{ agentId: string; text: string }> {
    const results: Array<{ agentId: string; text: string }> = [];
    for (const slot of workers.values()) {
        if (slot.state === 'done' && slot.pendingReplay && !slot.replayClaimed && slot.result) {
            results.push({ agentId: slot.agentId, text: slot.result });
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
}

export function clearAllWorkers(): void {
    workers.clear();
}
