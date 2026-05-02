import { randomUUID } from 'node:crypto';

export const MAX_TRACE_STEPS_LOCAL = 200;

export interface TraceStep {
    stepId?: string;
    ts?: string;
    action?: string;
    status?: string;
    target?: { resolution?: string | null; source?: string | null } | null;
    error?: unknown;
    errorCode?: string;
    [key: string]: unknown;
}

export interface TraceSummary {
    sessionId: string;
    totalSteps: number;
    resolutionSources: string[];
    errorCount: number;
    firstTs: string | null;
    lastTs: string | null;
}

export interface TraceContext {
    sessionId: string;
    snapshotHashBefore: string | null;
    steps: TraceStep[];
    record(step: TraceStep): void;
    setSnapshotHashBefore(hash: string | null): void;
}

export function createTraceContext(sessionId: string): TraceContext {
    const steps: TraceStep[] = [];
    return {
        sessionId,
        snapshotHashBefore: null,
        steps,
        record(step: TraceStep): void {
            if (steps.length >= MAX_TRACE_STEPS_LOCAL) return;
            steps.push({
                stepId: randomUUID().replace(/-/g, '').slice(0, 16),
                ts: new Date().toISOString(),
                ...step,
            });
        },
        setSnapshotHashBefore(hash: string | null): void {
            this.snapshotHashBefore = hash;
        },
    };
}

export function recordTraceStep(ctx: TraceContext | null | undefined, step: TraceStep): void {
    if (!ctx) return;
    ctx.record(step);
}

export function getSessionTrace(ctx: TraceContext | null | undefined): TraceStep[] {
    if (!ctx) return [];
    return [...ctx.steps];
}

export function summarizeTrace(ctx: TraceContext | null | undefined): TraceSummary | null {
    if (!ctx || !ctx.steps.length) return null;
    const sources = new Set<string>();
    let errors = 0;
    for (const step of ctx.steps) {
        if (step.target?.resolution) sources.add(step.target.resolution);
        if (step.target?.source) sources.add(step.target.source);
        if (step.status === 'error') errors += 1;
    }
    return {
        sessionId: ctx.sessionId,
        totalSteps: ctx.steps.length,
        resolutionSources: [...sources],
        errorCount: errors,
        firstTs: ctx.steps[0]?.ts || null,
        lastTs: ctx.steps.at(-1)?.ts || null,
    };
}
