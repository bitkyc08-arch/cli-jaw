// Goal-run controller: manages run state and drives forward-only PABCD transitions.
// Does NOT import provider SDKs.

import fs from 'node:fs';
import path from 'node:path';
import type { GoalRunState, GoalRunMode, GoalRunBudget } from './types.js';
import { checkPreflightGates, allGatesPassed, checkBudget } from './policy.js';
import { classifyFailure } from './failure-matrix.js';
import { getActiveGoal } from '../goal/store.js';
import { getState } from '../orchestrator/state-machine.js';
import { getActiveWorkers, hasPendingWorkerReplays } from '../orchestrator/worker-registry.js';
import { JAW_HOME } from '../core/config.js';

const GOAL_DIR = path.join(JAW_HOME, 'goal');
const ACTIVE_RUN_PATH = path.join(GOAL_DIR, 'active-run.json');

let activeRun: GoalRunState | null = null;

function persistRun(): void {
    if (!activeRun) return;
    fs.mkdirSync(GOAL_DIR, { recursive: true });
    const tmp = ACTIVE_RUN_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(activeRun, null, 2));
    fs.renameSync(tmp, ACTIVE_RUN_PATH);
}

function deleteRunFile(): void {
    try { fs.unlinkSync(ACTIVE_RUN_PATH); } catch { /* file may not exist */ }
}

function loadRun(): void {
    if (activeRun) return;
    try {
        const data = fs.readFileSync(ACTIVE_RUN_PATH, 'utf8');
        activeRun = JSON.parse(data) as GoalRunState;
    } catch { /* file doesn't exist or is corrupt — start fresh */ }
}

const DEFAULT_BUDGET: GoalRunBudget = {
    maxTurns: 10,
    maxMinutes: 60,
    maxDispatches: 5,
    turnsUsed: 0,
    minutesUsed: 0,
    dispatchesUsed: 0,
};

export function getActiveRun(): GoalRunState | null {
    loadRun();
    return activeRun;
}

export function preflight(mode: GoalRunMode = 'assist'): GoalRunState {
    const goal = getActiveGoal();
    const gates = checkPreflightGates({
        hasGoal: !!goal,
        orcState: getState(),
        workerBusy: getActiveWorkers().length > 0,
        pendingReplay: hasPendingWorkerReplays('default'),
    });
    const budgetGate = checkBudget(DEFAULT_BUDGET);
    gates.push(budgetGate);

    return {
        goalId: goal?.id ?? '',
        mode,
        status: 'preflight',
        budget: { ...DEFAULT_BUDGET },
        gates,
    };
}

export function startRun(mode: GoalRunMode = 'assist'): GoalRunState {
    const state = preflight(mode);
    if (!allGatesPassed(state.gates)) {
        state.status = 'failed';
        state.lastError = state.gates.filter(g => !g.passed).map(g => g.reason).join('; ');
        return state;
    }
    state.status = 'running';
    state.startedAt = new Date().toISOString();
    state.lastActiveAt = state.startedAt;
    activeRun = state;
    persistRun();
    return state;
}

export function pauseRun(): GoalRunState | null {
    if (!activeRun || activeRun.status !== 'running') return null;
    accumulateMinutes();
    activeRun.status = 'paused';
    persistRun();
    return activeRun;
}

export function resumeRun(): GoalRunState | null {
    if (!activeRun || activeRun.status !== 'paused') return null;
    const gates = checkPreflightGates({
        hasGoal: !!getActiveGoal(),
        orcState: getState(),
        workerBusy: getActiveWorkers().length > 0,
        pendingReplay: hasPendingWorkerReplays('default'),
    });
    const budgetGate = checkBudget(activeRun.budget);
    gates.push(budgetGate);

    if (!allGatesPassed(gates)) {
        activeRun.gates = gates;
        activeRun.lastError = gates.filter(g => !g.passed).map(g => g.reason).join('; ');
        return activeRun;
    }
    activeRun.status = 'running';
    activeRun.lastActiveAt = new Date().toISOString();
    activeRun.gates = gates;
    persistRun();
    return activeRun;
}

export function stopRun(reason?: string): GoalRunState | null {
    if (!activeRun) return null;
    accumulateMinutes();
    activeRun.status = 'stopped';
    activeRun.stoppedAt = new Date().toISOString();
    if (reason) activeRun.lastError = reason;
    const result = activeRun;
    activeRun = null;
    deleteRunFile();
    return result;
}

export function completeRun(): GoalRunState | null {
    if (!activeRun) return null;
    accumulateMinutes();
    activeRun.status = 'completed';
    activeRun.stoppedAt = new Date().toISOString();
    const result = activeRun;
    activeRun = null;
    deleteRunFile();
    return result;
}

function accumulateMinutes(): void {
    if (!activeRun?.lastActiveAt) return;
    const elapsed = (Date.now() - new Date(activeRun.lastActiveAt).getTime()) / 60_000;
    if (elapsed > 0) activeRun.budget.minutesUsed += elapsed;
    activeRun.lastActiveAt = new Date().toISOString();
}

export function recordTurn(): void {
    if (activeRun?.status === 'running') {
        accumulateMinutes();
        activeRun.budget.turnsUsed++;
        persistRun();
    }
}

export function recordDispatch(): void {
    if (activeRun?.status === 'running') {
        activeRun.budget.dispatchesUsed++;
        persistRun();
    }
}

export function handleFailure(phase: string, failureType: Parameters<typeof classifyFailure>[0]['failureType'], retryCount = 0) {
    const decision = classifyFailure({ phase, failureType, retryCount });
    if (decision.action === 'stop' && activeRun) {
        stopRun(decision.reason);
    }
    return decision;
}
