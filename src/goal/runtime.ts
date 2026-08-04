// Builds runtime snapshots from goal + PABCD + worker registry + heartbeat.
// Does NOT import provider SDKs.

import { getState } from '../orchestrator/state-machine.js';
import { getActiveWorkers, hasPendingWorkerReplays } from '../orchestrator/worker-registry.js';
import { getActiveGoal } from './store.js';
import type { GoalState } from './types.js';
import type { OrcStateName } from '../orchestrator/state-machine.js';
import type { GoalRunBudget } from '../goal-run/types.js';

export interface WorkflowRuntimeSnapshot {
    goal: GoalState | null;
    orcState: OrcStateName;
    activeRun: boolean;
    activeWorkers: number;
    pendingWorkerReplays: boolean;
    heartbeatBusy: boolean;
    heartbeatPendingJobs: number;
    dirtyWorktree?: boolean | undefined;
    budget: GoalRunBudget;
}

const DEFAULT_BUDGET: GoalRunBudget = {
    maxTurns: 10,
    maxMinutes: 60,
    maxDispatches: 5,
    turnsUsed: 0,
    minutesUsed: 0,
    dispatchesUsed: 0,
};

export function buildRuntimeSnapshot(overrides?: {
    heartbeatBusy?: boolean;
    heartbeatPendingJobs?: number;
    dirtyWorktree?: boolean;
    budget?: GoalRunBudget;
    activeRun?: boolean;
}): WorkflowRuntimeSnapshot {
    const goal = getActiveGoal();
    const orcState = getState();
    const workers = getActiveWorkers();
    const pendingReplays = hasPendingWorkerReplays('default');

    return {
        goal,
        orcState,
        activeRun: overrides?.activeRun ?? false,
        activeWorkers: workers.length,
        pendingWorkerReplays: pendingReplays,
        heartbeatBusy: overrides?.heartbeatBusy ?? false,
        heartbeatPendingJobs: overrides?.heartbeatPendingJobs ?? 0,
        dirtyWorktree: overrides?.dirtyWorktree,
        budget: overrides?.budget ?? DEFAULT_BUDGET,
    };
}
