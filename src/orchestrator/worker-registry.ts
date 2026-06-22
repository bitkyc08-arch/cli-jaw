// ─── Worker Registry ────────────────────────────────
// In-memory registry tracking worker ownership and result handoff.

import { randomUUID } from 'node:crypto';
import { stripUndefined } from '../core/strip-undefined.js';
import type { SanitizedToolLogEntry } from '../shared/tool-log-sanitize.js';
import {
    previewText,
    sanitizeWorkerProgressTools,
    type WorkerProgressAttention,
    type WorkerProgressRun,
    type WorkerProgressSnapshot,
} from './worker-progress.js';
import {
    completeWorkerRun,
    createWorkerRunRecord,
    recordWorkerRunAttention,
    recordWorkerRunProgress,
} from './worker-run-store.js';

const workers = new Map<string, WorkerSlot>();
const previousRuns = new Map<string, WorkerProgressRun>();
const previousRunIdsByAgentId = new Map<string, string[]>();

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
    runId: string;
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
    tools: SanitizedToolLogEntry[];
    progressUpdatedAt: number | null;
    attention: WorkerProgressAttention | null;
    /** Origin/target/chatId of the Boss session that dispatched this worker. */
    replayMeta?: WorkerReplayMeta;
    /** Verdict/persistence block computed at completion. Stored BEFORE the
     *  state flips to done so pollers can never observe a verdict-less done
     *  result (260613 review fix — the always-poll CLI lost the verdict the
     *  old blocking response used to carry). */
    orchestration?: Record<string, unknown>;
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

function createWorkerRunId(agentId: string): string {
    return `wr_${agentId}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function claimWorker(emp: WorkerEmployeeRef, task: string, replayMeta?: WorkerReplayMeta): WorkerSlot {
    const existing = workers.get(emp.id);
    if (existing && existing.state === 'running') {
        throw new WorkerBusyError(existing);
    }
    const slot: WorkerSlot = stripUndefined({
        runId: createWorkerRunId(emp.id),
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
        tools: [],
        progressUpdatedAt: null,
        attention: null,
        replayMeta: replayMeta && Object.keys(replayMeta).length ? { ...replayMeta } : undefined,
    });
    workers.set(emp.id, slot);
    createWorkerRunRecord({
        runId: slot.runId,
        agentId: slot.agentId,
        employeeName: slot.employeeName,
        taskPreview: previewText(slot.task, 200) || '',
        startedAt: slot.startedAt,
    });
    return slot;
}

export function getWorkerSlot(agentId: string): WorkerSlot | undefined {
    return workers.get(agentId) || [...workers.values()].find(slot => slot.runId === agentId);
}

export function updateWorkerPhase(agentId: string, phase: string, phaseLabel: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.phase = phase;
    slot.phaseLabel = phaseLabel;
}

function toProgressRun(slot: WorkerSlot): WorkerProgressRun {
    const now = Date.now();
    const resultPreview = previewText(slot.result, 240);
    const attention = progressAttention(slot);
    const endAt = slot.completedAt ?? now;
    return {
        runId: slot.runId,
        agentId: slot.agentId,
        employeeName: slot.employeeName,
        state: slot.state,
        taskPreview: previewText(slot.task, 200) || '',
        ...(slot.phase ? { phase: slot.phase } : {}),
        ...(slot.phaseLabel ? { phaseLabel: slot.phaseLabel } : {}),
        startedAt: slot.startedAt,
        completedAt: slot.completedAt,
        progressUpdatedAt: slot.progressUpdatedAt,
        elapsedMs: Math.max(0, endAt - slot.startedAt),
        lastUpdateAgeMs: slot.progressUpdatedAt ? Math.max(0, now - slot.progressUpdatedAt) : null,
        ...(resultPreview ? { resultPreview } : {}),
        ...(attention ? { attention } : {}),
        tools: slot.tools,
    };
}

function progressAttention(slot: WorkerSlot): WorkerProgressAttention | null {
    if (slot.attention) return slot.attention;
    if (slot.state === 'done' && slot.pendingReplay) {
        return {
            kind: slot.replayClaimed ? 'replay_claimed' : 'pending_replay',
            message: slot.replayClaimed
                ? 'Worker result delivery is in progress.'
                : 'Worker result is waiting for replay delivery.',
            occurredAt: slot.completedAt ?? Date.now(),
            attempts: slot.replayAttempts,
        };
    }
    return null;
}

function setWorkerAttention(agentId: string, attention: WorkerProgressAttention | null): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.attention = attention;
    slot.progressUpdatedAt = Date.now();
    recordWorkerRunAttention(slot.runId, attention);
}

export function markWorkerStalled(agentId: string): void {
    setWorkerAttention(agentId, {
        kind: 'stalled',
        message: 'Worker has not reported activity after the stall threshold.',
        occurredAt: Date.now(),
    });
}

export function markWorkerActive(agentId: string): void {
    const slot = workers.get(agentId);
    if (!slot || slot.attention?.kind !== 'stalled') return;
    setWorkerAttention(agentId, null);
}

export function markWorkerDisconnected(agentId: string, exitCode: number | null): void {
    setWorkerAttention(agentId, {
        kind: 'disconnected',
        message: 'Worker process disconnected before a clean completion.',
        occurredAt: Date.now(),
        exitCode,
    });
}

export function markWorkerTimedOut(agentId: string): void {
    setWorkerAttention(agentId, {
        kind: 'timeout',
        message: 'Worker exceeded the maximum allowed runtime and was stopped.',
        occurredAt: Date.now(),
    });
}

// Completed-run history is memory-only; failed/cancelled slots were never
// individually evicted, so persistent uptime accumulated one entry per
// dispatched agentId (260613 05 finding 4).
const PREVIOUS_RUNS_MAX = 100;

function rememberCompletedRun(slot: WorkerSlot): void {
    if (slot.state === 'running') return;
    previousRuns.set(slot.runId, toProgressRun(slot));
    const ids = previousRunIdsByAgentId.get(slot.agentId) || [];
    if (!ids.includes(slot.runId)) ids.push(slot.runId);
    previousRunIdsByAgentId.set(slot.agentId, ids);
    while (previousRuns.size > PREVIOUS_RUNS_MAX) {
        const oldest = previousRuns.keys().next().value;
        if (!oldest) break;
        const oldestRun = previousRuns.get(oldest);
        previousRuns.delete(oldest);
        if (oldestRun) {
            const agentRunIds = previousRunIdsByAgentId.get(oldestRun.agentId) || [];
            const filtered = agentRunIds.filter(id => id !== oldest);
            if (filtered.length > 0) previousRunIdsByAgentId.set(oldestRun.agentId, filtered);
            else previousRunIdsByAgentId.delete(oldestRun.agentId);
        }
    }
}

function latestPreviousRunForAgent(agentId: string): WorkerProgressRun | null {
    const ids = previousRunIdsByAgentId.get(agentId) || [];
    for (let index = ids.length - 1; index >= 0; index--) {
        const run = previousRuns.get(ids[index]!);
        if (run) return run;
    }
    return null;
}

function previousRunsForAgent(agentId: string): WorkerProgressRun[] {
    const ids = previousRunIdsByAgentId.get(agentId) || [];
    return ids.map(id => previousRuns.get(id)).filter((run): run is WorkerProgressRun => Boolean(run));
}

export function setWorkerOrchestration(agentId: string, orchestration: Record<string, unknown>): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.orchestration = orchestration;
}

export function updateWorkerTools(agentId: string, tools: unknown[]): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    if (slot.attention?.kind === 'stalled') slot.attention = null;
    slot.tools = sanitizeWorkerProgressTools(tools);
    slot.progressUpdatedAt = Date.now();
    recordWorkerRunProgress(slot.runId, slot.tools);
}

export function finishWorker(agentId: string, result: string, tools: unknown[] = []): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.state = 'done';
    slot.completedAt = Date.now();
    slot.result = result;
    if (tools.length > 0) updateWorkerTools(agentId, tools);
    completeWorkerRun(slot.runId, 'done', result);
    rememberCompletedRun(slot);
    slot.pendingReplay = true;
}

export function failWorker(agentId: string, result: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.state = 'failed';
    slot.completedAt = Date.now();
    slot.result = result;
    completeWorkerRun(slot.runId, 'failed', result);
    rememberCompletedRun(slot);
    slot.pendingReplay = false;  // Failed workers don't need replay — no result to feed back to Boss
}

export function cancelWorker(agentId: string): void {
    const slot = workers.get(agentId);
    if (!slot) return;
    slot.state = 'cancelled';
    slot.completedAt = Date.now();
    slot.pendingReplay = false;
    completeWorkerRun(slot.runId, 'cancelled', slot.result || '');
    rememberCompletedRun(slot);
    workers.delete(agentId);
}

export function getWorkerProgressSnapshot(agentId: string): WorkerProgressSnapshot | null {
    const slot = workers.get(agentId);
    const runSlot = slot || [...workers.values()].find(value => value.runId === agentId);
    const previousByRunId = previousRuns.get(agentId) || null;
    const previousByAgent = latestPreviousRunForAgent(agentId);
    const previous = previousByRunId || (runSlot ? latestPreviousRunForAgent(runSlot.agentId) : previousByAgent);
    const currentRun = runSlot?.state === 'running' ? toProgressRun(runSlot) : null;
    const previousRun = runSlot && runSlot.state !== 'running' ? toProgressRun(runSlot) : previous;
    if (!runSlot && !previousRun) return null;
    return {
        runId: currentRun?.runId || previousRun?.runId || null,
        agentId: runSlot?.agentId || previousRun?.agentId || agentId,
        employeeName: runSlot?.employeeName || previousRun?.employeeName || agentId,
        current: currentRun,
        previous: previousRun,
        ...(previousRunsForAgent(runSlot?.agentId || previousRun?.agentId || agentId).length > 1
            ? { previousRuns: previousRunsForAgent(runSlot?.agentId || previousRun?.agentId || agentId) }
            : {}),
        generatedAt: Date.now(),
    };
}

export function listWorkerProgressSnapshots(): WorkerProgressSnapshot[] {
    const snapshots = [...workers.keys()]
        .map(getWorkerProgressSnapshot)
        .filter((value): value is WorkerProgressSnapshot => Boolean(value));
    const seenRunIds = new Set(snapshots.flatMap(snapshot => [
        snapshot.current?.runId,
        snapshot.previous?.runId,
    ]).filter((value): value is string => Boolean(value)));
    for (const run of previousRuns.values()) {
        if (seenRunIds.has(run.runId)) continue;
        snapshots.push({
            runId: run.runId,
            agentId: run.agentId,
            employeeName: run.employeeName,
            current: null,
            previous: run,
            generatedAt: Date.now(),
        });
    }
    return snapshots;
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

export function listPendingWorkerResults(): Array<{ agentId: string; runId: string; text: string; tools?: SanitizedToolLogEntry[]; meta?: WorkerReplayMeta }> {
    const results: Array<{ agentId: string; runId: string; text: string; tools?: SanitizedToolLogEntry[]; meta?: WorkerReplayMeta }> = [];
    for (const slot of workers.values()) {
        if (slot.state === 'done' && slot.pendingReplay && !slot.replayClaimed && slot.result !== null) {
            results.push(stripUndefined({
                agentId: slot.agentId,
                runId: slot.runId,
                text: slot.result,
                tools: slot.tools.length > 0 ? slot.tools : undefined,
                meta: slot.replayMeta,
            }));
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
        slot.attention = {
            kind: 'replay_failed',
            message: 'Worker result replay failed after 3 attempts.',
            occurredAt: Date.now(),
            attempts: slot.replayAttempts,
        };
        recordWorkerRunAttention(slot.runId, slot.attention);
        completeWorkerRun(slot.runId, 'failed', slot.result || '');
        rememberCompletedRun(slot);
    }
}

export function clearAllWorkers(): void {
    workers.clear();
    previousRuns.clear();
    previousRunIdsByAgentId.clear();
}
