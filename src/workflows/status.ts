// Stable workflow status JSON — SDK-free.
// Consumed by CLI automation and frontend hydration.

import type { WorkflowStatusV1 } from './types.js';
import type { GoalState } from '../goal/types.js';
import type { GoalRunState } from '../goal-run/types.js';
import type { TeamRun } from '../team/types.js';
import type { OrcStateName } from '../orchestrator/state-machine.js';
import { describeGoalPauseGate } from '../goal/pause-gate.js';

export function goalToStatus(goal: GoalState | null, phase?: OrcStateName): WorkflowStatusV1 | null {
    if (!goal) return null;
    const pauseGate = describeGoalPauseGate(goal);
    const blockers: Array<{ code: string; message: string }> = [];
    if (goal.status === 'blocked') {
        blockers.push({ code: 'goal-blocked', message: 'Goal is in blocked state' });
    }
    if (pauseGate.armed) {
        blockers.push({
            code: 'goal-pause-gate-pending',
            message: pauseGate.nextAction ?? 'Agent pause gate is pending.',
        });
    }
    return {
        workflow: 'goal',
        id: goal.id,
        state: goal.status,
        phase,
        updatedAt: goal.updatedAt,
        blockers: blockers.length ? blockers : undefined,
        confirmationRequired: pauseGate.armed,
    };
}

export function goalRunToStatus(run: GoalRunState | null, phase?: OrcStateName): WorkflowStatusV1 | null {
    if (!run) return null;
    const blockers = run.gates
        .filter(g => !g.passed)
        .map(g => ({ code: g.gate, message: g.reason ?? 'Gate failed' }));
    return {
        workflow: 'goal-run',
        id: run.goalId,
        state: run.status,
        phase,
        updatedAt: run.startedAt ?? new Date().toISOString(),
        blockers: blockers.length ? blockers : undefined,
        confirmationRequired: run.status === 'preflight',
    };
}

export function teamToStatus(run: TeamRun | null): WorkflowStatusV1 | null {
    if (!run) return null;
    const blockedLanes = run.plan.lanes.filter(l => l.state === 'blocked');
    return {
        workflow: 'team',
        id: run.teamId,
        state: run.state,
        updatedAt: run.startedAt ?? run.plan.createdAt,
        blockers: blockedLanes.length
            ? blockedLanes.map(l => ({ code: `lane-blocked-${l.laneId}`, message: `Lane ${l.role} is blocked` }))
            : undefined,
        confirmationRequired: run.state === 'planned',
    };
}
