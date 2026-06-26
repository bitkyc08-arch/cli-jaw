import type { GoalPauseGateState, GoalState } from './types.js';

export const REQUIRED_AGENT_PAUSE_ATTEMPTS = 2;

const PAUSE_GATE_NEXT_ACTION = 'Run a second audited agent pause if no viable path remains, or log a productive checkpoint to clear the pending pause gate.';

function normalizeAttempts(value: number | undefined): number {
    if (!Number.isFinite(value ?? 0)) return 0;
    return Math.max(0, Math.trunc(value ?? 0));
}

export function describeGoalPauseGate(goal: GoalState | null): GoalPauseGateState {
    const attempts = normalizeAttempts(goal?.agentPauseCount);
    const armed = goal?.status === 'active' && attempts >= 1;
    return {
        armed,
        attempts,
        requiredAttempts: REQUIRED_AGENT_PAUSE_ATTEMPTS,
        reason: armed ? 'pause_gate_pending' : null,
        nextAction: armed ? PAUSE_GATE_NEXT_ACTION : null,
    };
}

export function isGoalPauseGateArmed(goal: GoalState | null): boolean {
    return describeGoalPauseGate(goal).armed;
}
