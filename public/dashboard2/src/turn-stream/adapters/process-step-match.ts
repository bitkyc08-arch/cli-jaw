export interface ProcessStep {
    id: string;
    type: 'tool' | 'thinking' | 'search' | 'subagent';
    icon: string;
    rawIcon?: string | undefined;
    label: string;
    isEmployee?: boolean | undefined;
    detail?: string;
    stepRef?: string | undefined;
    traceRunId?: string | undefined;
    traceSeq?: number | undefined;
    detailAvailable?: boolean | undefined;
    detailBytes?: number | undefined;
    rawRetentionStatus?: string | undefined;
    status: 'running' | 'done' | 'error';
    startTime: number;
}

function hasPositiveTraceSeq(step: ProcessStep): boolean {
    return typeof step.traceSeq === 'number' && Number.isFinite(step.traceSeq) && step.traceSeq > 0;
}

function sameTraceIdentity(existing: ProcessStep, incoming: ProcessStep): boolean {
    return Boolean(incoming.traceRunId)
        && Boolean(existing.traceRunId)
        && incoming.traceRunId === existing.traceRunId
        && hasPositiveTraceSeq(incoming)
        && hasPositiveTraceSeq(existing)
        && incoming.traceSeq === existing.traceSeq
        && incoming.type === existing.type
        && incoming.label === existing.label
        && Boolean(incoming.isEmployee) === Boolean(existing.isEmployee);
}

export function sameProcessStepIdentity(existing: ProcessStep, incoming: ProcessStep): boolean {
    if (incoming.stepRef && existing.stepRef === incoming.stepRef) return true;
    return sameTraceIdentity(existing, incoming);
}

export function findProcessStepByIdentity(
    steps: ProcessStep[],
    step: ProcessStep,
    options: { includeDone?: boolean } = {},
): ProcessStep | null {
    const candidates = [...steps].reverse().filter(s => options.includeDone || s.status === 'running');
    return candidates.find(s => sameProcessStepIdentity(s, step)) ?? null;
}

export function findLegacyRunningMatch(steps: ProcessStep[], step: ProcessStep): ProcessStep | null {
    const matches = steps.filter(s => s.status === 'running'
        && !s.stepRef
        && s.label === step.label
        && s.type === step.type
        && Boolean(s.isEmployee) === Boolean(step.isEmployee));
    return matches.length === 1 ? matches[0]! : null;
}

export function findRunningProcessStepMatch(steps: ProcessStep[], step: ProcessStep): ProcessStep | null {
    const running = [...steps].reverse().filter(s => s.status === 'running');
    const identityMatch = findProcessStepByIdentity(running, step);
    if (identityMatch) return identityMatch;
    return findLegacyRunningMatch(running, step);
}
