import type { RuntimeTurnOutcome } from '../../shared/runtime-contract.js';

export interface RuntimeOutcomeContext {
    runtimeOutcome?: RuntimeTurnOutcome;
}

/** Keep native completion independent of projection/journal availability. */
export function handoffRuntimeOutcome(context: RuntimeOutcomeContext, outcome: RuntimeTurnOutcome): void {
    context.runtimeOutcome = {
        status: outcome.status,
        finalText: outcome.finalText,
        partialText: outcome.partialText,
    };
}

export function lifecycleRuntimeOutcome(context: RuntimeOutcomeContext, stopped: boolean): RuntimeTurnOutcome | undefined {
    const outcome = context.runtimeOutcome;
    if (outcome === undefined) return undefined;
    return {
        status: stopped ? 'stopped' : outcome.status,
        finalText: outcome.finalText,
        partialText: outcome.partialText,
    };
}

export function runtimeOutcomeExitCode(outcome: RuntimeTurnOutcome | undefined, processCode: number | null): number | null {
    if (outcome === undefined) return processCode;
    if (outcome.status === 'done') return 0;
    if (processCode !== null && processCode !== 0) return processCode;
    return outcome.status === 'stopped' ? 130 : 1;
}
